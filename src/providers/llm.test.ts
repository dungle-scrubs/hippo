import type { UserMessage } from "@mariozechner/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLlmProvider } from "./llm.js";

/** Minimal mock chat completions server. */
let server: ReturnType<typeof import("node:http").createServer>;
let baseUrl: string;

beforeAll(async () => {
	const { createServer } = await import("node:http");
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			const parsed = JSON.parse(body);

			// Check auth
			if (req.headers.authorization !== "Bearer test-key") {
				res.writeHead(401);
				res.end(JSON.stringify({ error: "unauthorized" }));
				return;
			}

			// Echo back the user's last message as the response
			const lastMsg = parsed.messages[parsed.messages.length - 1];
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					choices: [
						{
							message: {
								content: `echo: ${lastMsg.content}`,
								role: "assistant",
							},
						},
					],
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

describe("createLlmProvider", () => {
	it("sends system prompt and messages, returns text", async () => {
		const llm = createLlmProvider({
			apiKey: "test-key",
			baseUrl,
			model: "test-model",
		});

		const msg: UserMessage = {
			content: [{ type: "text", text: "hello" }],
			role: "user",
			timestamp: Date.now(),
		};

		const result = await llm.complete([msg], "You are helpful.");
		expect(result).toBe("echo: hello");
	});

	it("handles string content in messages", async () => {
		const llm = createLlmProvider({
			apiKey: "test-key",
			baseUrl,
			model: "test-model",
		});

		// pi-ai allows string content on user messages
		const msg = {
			content: "direct string",
			role: "user" as const,
			timestamp: Date.now(),
		};

		const result = await llm.complete([msg as UserMessage], "system");
		expect(result).toBe("echo: direct string");
	});

	it("throws on auth failure", async () => {
		const llm = createLlmProvider({
			apiKey: "wrong-key",
			baseUrl,
			model: "test-model",
		});

		const msg: UserMessage = {
			content: [{ type: "text", text: "hello" }],
			role: "user",
			timestamp: Date.now(),
		};

		await expect(llm.complete([msg], "system")).rejects.toThrow("LLM API error 401");
	});
});
