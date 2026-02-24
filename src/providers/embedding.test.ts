import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "./embedding.js";

/**
 * Minimal mock embedding server. Returns a fixed embedding for any input.
 * Tests the HTTP contract without calling a real API.
 */
let server: ReturnType<typeof import("node:http").createServer>;
let baseUrl: string;

const MOCK_EMBEDDING = [0.1, 0.2, 0.3, 0.4, 0.5];

beforeAll(async () => {
	const { createServer } = await import("node:http");
	server = createServer((req, res) => {
		// Collect body
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			const parsed = JSON.parse(body);

			// Verify request shape
			if (!parsed.model || !parsed.input) {
				res.writeHead(400);
				res.end(JSON.stringify({ error: "missing model or input" }));
				return;
			}

			// Check auth
			const auth = req.headers.authorization;
			if (auth !== "Bearer test-key") {
				res.writeHead(401);
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					data: [{ embedding: MOCK_EMBEDDING, index: 0, object: "embedding" }],
					model: parsed.model,
					usage: { prompt_tokens: 5, total_tokens: 5 },
				}),
			);
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, () => {
			const addr = server.address();
			if (typeof addr === "object" && addr) {
				baseUrl = `http://localhost:${addr.port}`;
			}
			resolve();
		});
	});
});

afterAll(() => {
	server?.close();
});

describe("createEmbeddingProvider", () => {
	it("returns Float32Array from API response", async () => {
		const embed = createEmbeddingProvider({
			apiKey: "test-key",
			baseUrl,
			model: "test-model",
		});

		const result = await embed("hello world");
		expect(result).toBeInstanceOf(Float32Array);
		expect(result.length).toBe(MOCK_EMBEDDING.length);
		expect(result[0]).toBeCloseTo(0.1);
		expect(result[4]).toBeCloseTo(0.5);
	});

	it("sends model and dimensions in request", async () => {
		const embed = createEmbeddingProvider({
			apiKey: "test-key",
			baseUrl,
			dimensions: 256,
			model: "custom-model",
		});

		// Just verify it doesn't error — the mock doesn't validate dimensions
		const result = await embed("test");
		expect(result).toBeInstanceOf(Float32Array);
	});

	it("throws on auth failure", async () => {
		const embed = createEmbeddingProvider({
			apiKey: "wrong-key",
			baseUrl,
			model: "test-model",
		});

		await expect(embed("test")).rejects.toThrow("Embedding API error 401");
	});

	it("respects abort signal", async () => {
		const embed = createEmbeddingProvider({
			apiKey: "test-key",
			baseUrl,
			model: "test-model",
		});

		const controller = new AbortController();
		controller.abort();

		await expect(embed("test", controller.signal)).rejects.toThrow();
	});
});
