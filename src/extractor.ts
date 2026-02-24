import type { UserMessage } from "@mariozechner/pi-ai";
import type { ConflictClassification, ExtractedFact, LlmClient } from "./types.js";

/**
 * Build a pi-ai UserMessage from text content.
 *
 * @param content - Message text
 * @returns UserMessage compatible with pi-ai's Message type
 */
function userMessage(content: string): UserMessage {
	return { content, role: "user", timestamp: Date.now() };
}

const EXTRACTION_SYSTEM_PROMPT = `You extract discrete facts from user text and rate each fact's intensity.

Rules:
- Extract ONLY factual claims, preferences, or decisions. Not questions or filler.
- Each fact should be a single, atomic statement.
- Rate intensity 0.0–1.0 based on:
  - Emotional charge ("hate", "love", "nightmare") → higher
  - Consequence language ("cost us the client") → higher
  - Absolute language ("never", "always", "I refuse") → higher
  - Identity statements ("I'm a backend person") → higher
  - Explicit importance ("remember this", "this is critical") → higher
  - Casual aside, no signal → 0.1–0.2
  - Clear statement with mild opinion → 0.3–0.5
  - Strong conviction or emotional charge → 0.6–0.8
  - Sustained pattern + identity-level → 0.85–1.0

Respond with ONLY a JSON array. No markdown, no explanation.
Example:
[{"fact": "User dislikes Redux", "intensity": 0.85}, {"fact": "User tried a café on Sukhumvit", "intensity": 0.15}]

If there are no extractable facts, respond with an empty array: []`;

const CLASSIFICATION_SYSTEM_PROMPT = `You classify the relationship between a new fact and an existing fact.

Respond with EXACTLY one word: DUPLICATE, SUPERSEDES, or DISTINCT.

- DUPLICATE: Same information, different wording. Example: "User lives in Berlin" vs "User's city is Berlin"
- SUPERSEDES: Same topic, new value replaces old. Example: "User lives in Berlin" vs "User lives in Bangkok"
- DISTINCT: Related but both can be true simultaneously. Example: "User likes TypeScript" vs "User likes Rust"

Respond with ONLY the classification word. No explanation.`;

/**
 * Extract discrete facts from text with intensity ratings.
 *
 * @param text - User text to extract facts from
 * @param llm - LLM client for extraction
 * @param signal - Optional abort signal
 * @returns Array of extracted facts with intensity ratings
 */
export async function extractFacts(
	text: string,
	llm: LlmClient,
	signal?: AbortSignal,
): Promise<readonly ExtractedFact[]> {
	const response = await llm.complete([userMessage(text)], EXTRACTION_SYSTEM_PROMPT, signal);

	const parsed = parseJsonArray(response);
	if (!parsed) {
		return [];
	}

	return parsed
		.filter(isValidExtractedFact)
		.map((f) => ({
			fact: f.fact.trim(),
			intensity: Math.max(0, Math.min(1, f.intensity)),
		}))
		.filter((f) => f.fact.length > 0);
}

/**
 * Classify the relationship between a new fact and an existing fact.
 *
 * Only called for candidates in the ambiguous similarity band (0.78–0.93).
 *
 * @param newFact - The newly extracted fact
 * @param existingFact - The existing fact to compare against
 * @param llm - LLM client for classification
 * @param signal - Optional abort signal
 * @returns Classification: DUPLICATE, SUPERSEDES, or DISTINCT
 */
export async function classifyConflict(
	newFact: string,
	existingFact: string,
	llm: LlmClient,
	signal?: AbortSignal,
): Promise<ConflictClassification> {
	const prompt = `New fact: "${newFact}"\nExisting fact: "${existingFact}"`;

	const response = await llm.complete([userMessage(prompt)], CLASSIFICATION_SYSTEM_PROMPT, signal);

	const firstWord = response
		.trim()
		.split(/\s/)[0]
		?.replace(/[^A-Za-z]/g, "")
		.toUpperCase();
	if (firstWord === "DUPLICATE" || firstWord === "SUPERSEDES" || firstWord === "DISTINCT") {
		return firstWord;
	}

	// Default to DISTINCT if LLM returns garbage
	return "DISTINCT";
}

/**
 * Parse a JSON array from an LLM response, tolerating markdown fences.
 *
 * @param text - Raw LLM response
 * @returns Parsed array or null
 */
function parseJsonArray(text: string): unknown[] | null {
	let cleaned = text.trim();

	// Strip markdown code fences if present
	if (cleaned.startsWith("```")) {
		cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
	}

	try {
		const parsed: unknown = JSON.parse(cleaned);
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Type guard for extracted fact shape.
 *
 * @param value - Unknown value to check
 * @returns True if value matches ExtractedFact shape
 */
function isValidExtractedFact(value: unknown): value is ExtractedFact {
	return (
		typeof value === "object" &&
		value !== null &&
		"fact" in value &&
		typeof (value as ExtractedFact).fact === "string" &&
		"intensity" in value &&
		typeof (value as ExtractedFact).intensity === "number"
	);
}
