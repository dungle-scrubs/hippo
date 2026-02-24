/**
 * OpenAI-compatible LLM provider.
 *
 * Calls any API implementing `/v1/chat/completions` and implements
 * hippo's LlmClient interface. Used for fact extraction and conflict
 * classification — always non-streaming.
 */

import type { Message } from "@mariozechner/pi-ai";
import type { LlmClient } from "../types.js";

/** Configuration for the LLM provider. */
export interface LlmProviderConfig {
	/** API key for authentication (sent as Bearer token). */
	readonly apiKey: string;
	/** Base URL of the OpenAI-compatible API (e.g. "https://openrouter.ai/api/v1"). */
	readonly baseUrl: string;
	/** Model identifier (e.g. "google/gemini-flash-2.0"). */
	readonly model: string;
	/** Maximum tokens for completion (default: 2048). */
	readonly maxTokens?: number;
	/** Temperature (default: 0). */
	readonly temperature?: number;
}

/** OpenAI chat message shape. */
interface ChatMessage {
	readonly content: string;
	readonly role: "assistant" | "system" | "user";
}

/** Shape of the OpenAI chat completions API response. */
interface ChatCompletionResponse {
	readonly choices: readonly [{ readonly message: { readonly content: string } }];
}

/**
 * Convert pi-ai Message[] to OpenAI chat messages.
 *
 * Extracts text content from pi-ai's content block arrays.
 *
 * @param messages - pi-ai Message array
 * @returns OpenAI-compatible chat messages
 */
function toOpenAIMessages(messages: readonly Message[]): ChatMessage[] {
	const result: ChatMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "user" || msg.role === "assistant") {
			let text: string;
			if (typeof msg.content === "string") {
				text = msg.content;
			} else {
				text = msg.content
					.filter(
						(c: { type: string; text?: string }): c is { type: "text"; text: string } =>
							c.type === "text",
					)
					.map((c) => c.text)
					.join("\n");
			}
			if (text) {
				result.push({ content: text, role: msg.role });
			}
		}
	}
	return result;
}

/**
 * Create an LlmClient from OpenAI-compatible API config.
 *
 * @param config - Provider configuration
 * @returns LlmClient instance
 */
export function createLlmProvider(config: LlmProviderConfig): LlmClient {
	const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

	return {
		async complete(
			messages: Message[],
			systemPrompt: string,
			signal?: AbortSignal,
		): Promise<string> {
			const chatMessages: ChatMessage[] = [
				{ content: systemPrompt, role: "system" },
				...toOpenAIMessages(messages),
			];

			const response = await fetch(url, {
				body: JSON.stringify({
					max_tokens: config.maxTokens ?? 2048,
					messages: chatMessages,
					model: config.model,
					temperature: config.temperature ?? 0,
				}),
				headers: {
					Authorization: `Bearer ${config.apiKey}`,
					"Content-Type": "application/json",
				},
				method: "POST",
				signal,
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => "unknown error");
				throw new Error(`LLM API error ${response.status}: ${errorText}`);
			}

			const json = (await response.json()) as ChatCompletionResponse;
			return json.choices[0].message.content;
		},
	};
}
