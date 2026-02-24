import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { type DbStatements, getActiveChunks } from "../db.js";
import { classifyConflict, extractFacts } from "../extractor.js";
import { chunkEmbedding, cosineSimilarity, embeddingToBuffer } from "../similarity.js";
import { updatedIntensity } from "../strength.js";
import type {
	Chunk,
	EmbedFn,
	LlmClient,
	RememberFactAction,
	RememberFactsResult,
} from "../types.js";
import { ulid } from "../ulid.js";

/** Similarity thresholds for auto-classification. */
const DUPLICATE_THRESHOLD = 0.93;
const AMBIGUOUS_THRESHOLD = 0.78;

/** Top N existing chunks to compare against. */
const TOP_K_CANDIDATES = 5;

const Params = Type.Object({
	text: Type.String({
		description: "Text containing facts to extract and remember",
	}),
});

/** Options for creating the remember_facts tool. */
export interface RememberFactsToolOptions {
	readonly agentId: string;
	readonly embed: EmbedFn;
	readonly llm: LlmClient;
	readonly stmts: DbStatements;
}

/**
 * Create the remember_facts tool.
 *
 * Full pipeline: extract → embed → conflict check → insert/replace/strengthen.
 *
 * @param opts - Tool options
 * @returns AgentTool instance
 */
export function createRememberFactsTool(opts: RememberFactsToolOptions): AgentTool<typeof Params> {
	return {
		description:
			"Extract discrete facts from text, rate their intensity, check for conflicts with existing knowledge, and store. Handles duplicates, supersession, and new facts.",
		execute: async (_toolCallId, params, signal) => {
			const extracted = await extractFacts(params.text, opts.llm, signal);

			if (extracted.length === 0) {
				const result: AgentToolResult<RememberFactsResult> = {
					content: [{ text: "No facts extracted.", type: "text" }],
					details: { facts: [] },
				};
				return result;
			}

			const actions: RememberFactAction[] = [];

			// No transaction wrapper — intentional. Each fact is independently meaningful,
			// so partial insertion on mid-batch failure is acceptable. The alternative
			// (all-or-nothing) would discard successfully processed facts on a transient
			// embed/LLM error, which is worse for the user.
			//
			// Load facts once — processFact maintains this array across iterations
			// for intra-batch visibility (e.g., dedup between extracted facts).
			const existingFacts = getActiveChunks(opts.stmts, opts.agentId, "fact");

			for (const { fact, intensity } of extracted) {
				const action = await processFact(fact, intensity, existingFacts, opts, signal);
				actions.push(action);
			}

			const summary = actions
				.map((a) => {
					switch (a.action) {
						case "inserted":
							return `New: "${a.content}" (intensity: ${a.intensity.toFixed(2)})`;
						case "reinforced":
							return `Reinforced: "${a.content}" (${a.oldIntensity.toFixed(2)} → ${a.newIntensity.toFixed(2)})`;
						case "superseded":
							return `Superseded: "${a.oldContent}" → "${a.content}"`;
						default: {
							const _exhaustive: never = a;
							return _exhaustive;
						}
					}
				})
				.join("\n");

			const result: AgentToolResult<RememberFactsResult> = {
				content: [{ text: `Processed ${actions.length} facts:\n${summary}`, type: "text" }],
				details: { facts: actions },
			};
			return result;
		},
		label: "Remember Facts",
		name: "remember_facts",
		parameters: Params,
	};
}

/**
 * Process a single extracted fact through the conflict resolution pipeline.
 *
 * Mutates `existingFacts` to reflect inserts, reinforcements, and supersessions
 * so subsequent facts in the same batch see up-to-date state without re-querying.
 *
 * @param fact - Extracted fact text
 * @param intensity - Rated intensity [0, 1]
 * @param existingFacts - Mutable array of active fact chunks (updated in place)
 * @param opts - Tool options
 * @param signal - Optional abort signal
 * @returns Action taken for this fact
 */
async function processFact(
	fact: string,
	intensity: number,
	existingFacts: Chunk[],
	opts: RememberFactsToolOptions,
	signal?: AbortSignal,
): Promise<RememberFactAction> {
	const now = new Date().toISOString();
	const embedding = await opts.embed(fact, signal);
	const embeddingBuf = embeddingToBuffer(embedding);

	// Find top candidates by similarity
	const candidates = findTopCandidates(embedding, existingFacts, TOP_K_CANDIDATES);

	// Check best candidate for conflict
	const best = candidates[0];
	if (!best || best.similarity < AMBIGUOUS_THRESHOLD) {
		// NEW — no similar existing fact
		const chunk: Chunk = {
			access_count: 0,
			agent_id: opts.agentId,
			content: fact,
			content_hash: null,
			created_at: now,
			embedding: embeddingBuf,
			encounter_count: 1,
			id: ulid(),
			kind: "fact",
			last_accessed_at: now,
			metadata: null,
			running_intensity: intensity,
			superseded_by: null,
		};
		opts.stmts.insertChunk.run(chunk);
		existingFacts.push(chunk);

		return { action: "inserted", content: fact, intensity };
	}

	// Determine classification
	let classification: "DISTINCT" | "DUPLICATE" | "SUPERSEDES";
	if (best.similarity > DUPLICATE_THRESHOLD) {
		classification = "DUPLICATE";
	} else {
		// Ambiguous band — ask LLM
		classification = await classifyConflict(fact, best.chunk.content, opts.llm, signal);
	}

	switch (classification) {
		case "DUPLICATE": {
			const newIntensity = updatedIntensity(
				best.chunk.running_intensity,
				best.chunk.encounter_count,
				intensity,
			);
			opts.stmts.reinforceChunk.run({
				id: best.chunk.id,
				last_accessed_at: now,
				running_intensity: newIntensity,
			});

			// Update in-memory entry so subsequent facts see current values
			const idx = existingFacts.indexOf(best.chunk);
			if (idx !== -1) {
				existingFacts[idx] = {
					...best.chunk,
					access_count: best.chunk.access_count + 1,
					encounter_count: best.chunk.encounter_count + 1,
					last_accessed_at: now,
					running_intensity: newIntensity,
				};
			}

			return {
				action: "reinforced",
				content: best.chunk.content,
				newIntensity,
				oldIntensity: best.chunk.running_intensity,
			};
		}

		case "SUPERSEDES": {
			const newId = ulid();
			opts.stmts.supersedeChunk.run(newId, best.chunk.id);

			// Remove superseded chunk from in-memory array
			const idx = existingFacts.indexOf(best.chunk);
			if (idx !== -1) existingFacts.splice(idx, 1);

			const chunk: Chunk = {
				access_count: 0,
				agent_id: opts.agentId,
				content: fact,
				content_hash: null,
				created_at: now,
				embedding: embeddingBuf,
				encounter_count: 1,
				id: newId,
				kind: "fact",
				last_accessed_at: now,
				metadata: null,
				running_intensity: intensity,
				superseded_by: null,
			};
			opts.stmts.insertChunk.run(chunk);
			existingFacts.push(chunk);

			return {
				action: "superseded",
				content: fact,
				oldContent: best.chunk.content,
			};
		}

		case "DISTINCT": {
			const chunk: Chunk = {
				access_count: 0,
				agent_id: opts.agentId,
				content: fact,
				content_hash: null,
				created_at: now,
				embedding: embeddingBuf,
				encounter_count: 1,
				id: ulid(),
				kind: "fact",
				last_accessed_at: now,
				metadata: null,
				running_intensity: intensity,
				superseded_by: null,
			};
			opts.stmts.insertChunk.run(chunk);
			existingFacts.push(chunk);

			return { action: "inserted", content: fact, intensity };
		}
	}
}

/** Candidate chunk with its similarity score. */
interface ScoredCandidate {
	readonly chunk: Chunk;
	readonly similarity: number;
}

/**
 * Find the top K most similar existing chunks to a query embedding.
 *
 * @param queryEmbedding - The new fact's embedding
 * @param existingChunks - All active chunks to search
 * @param topK - Number of candidates to return
 * @returns Sorted candidates (highest similarity first)
 */
function findTopCandidates(
	queryEmbedding: Float32Array,
	existingChunks: readonly Chunk[],
	topK: number,
): readonly ScoredCandidate[] {
	const scored: ScoredCandidate[] = existingChunks.map((chunk) => ({
		chunk,
		similarity: cosineSimilarity(queryEmbedding, chunkEmbedding(chunk)),
	}));

	scored.sort((a, b) => b.similarity - a.similarity);
	return scored.slice(0, topK);
}
