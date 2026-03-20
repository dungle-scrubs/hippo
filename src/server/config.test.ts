import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./config.js";

/** Save and restore env vars around each test. */
const KEYS = [
	"HIPPO_DB",
	"HIPPO_EMBED_KEY",
	"HIPPO_LLM_KEY",
	"HIPPO_PORT",
	"HIPPO_EMBED_DIMENSIONS",
	"HIPPO_TRANSPORT",
	"HIPPO_EMBED_URL",
	"HIPPO_EMBED_MODEL",
	"HIPPO_LLM_URL",
	"HIPPO_LLM_MODEL",
] as const;

type EnvSnapshot = Record<string, string | undefined>;

let savedEnv: EnvSnapshot;

beforeEach(() => {
	savedEnv = {};
	for (const key of KEYS) {
		savedEnv[key] = process.env[key];
	}
});

afterEach(() => {
	for (const key of KEYS) {
		if (savedEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = savedEnv[key];
		}
	}
});

/** Set minimum required env vars for a valid config. */
function setRequiredEnv(): void {
	process.env.HIPPO_DB = "/tmp/test.db";
	process.env.HIPPO_EMBED_KEY = "sk-embed";
	process.env.HIPPO_LLM_KEY = "sk-llm";
}

describe("resolveConfig", () => {
	it("throws on missing HIPPO_DB", () => {
		process.env.HIPPO_EMBED_KEY = "sk-embed";
		process.env.HIPPO_LLM_KEY = "sk-llm";
		delete process.env.HIPPO_DB;
		expect(() => resolveConfig()).toThrow("HIPPO_DB");
	});

	it("throws on missing HIPPO_EMBED_KEY", () => {
		process.env.HIPPO_DB = "/tmp/test.db";
		process.env.HIPPO_LLM_KEY = "sk-llm";
		delete process.env.HIPPO_EMBED_KEY;
		expect(() => resolveConfig()).toThrow("HIPPO_EMBED_KEY");
	});

	it("resolves valid config with defaults", () => {
		setRequiredEnv();
		const config = resolveConfig();
		expect(config.db).toBe("/tmp/test.db");
		expect(config.port).toBe(3100);
		expect(config.transport).toBe("http");
		expect(config.embedding.model).toBe("text-embedding-3-small");
	});

	it("throws on invalid HIPPO_PORT", () => {
		setRequiredEnv();
		process.env.HIPPO_PORT = "abc";
		expect(() => resolveConfig()).toThrow("Invalid HIPPO_PORT");
	});

	it("throws on out-of-range HIPPO_PORT", () => {
		setRequiredEnv();
		process.env.HIPPO_PORT = "99999";
		expect(() => resolveConfig()).toThrow("Invalid HIPPO_PORT");
	});

	it("accepts valid HIPPO_PORT", () => {
		setRequiredEnv();
		process.env.HIPPO_PORT = "8080";
		const config = resolveConfig();
		expect(config.port).toBe(8080);
	});

	it("throws on invalid HIPPO_EMBED_DIMENSIONS", () => {
		setRequiredEnv();
		process.env.HIPPO_EMBED_DIMENSIONS = "not-a-number";
		expect(() => resolveConfig()).toThrow("Invalid HIPPO_EMBED_DIMENSIONS");
	});

	it("throws on zero HIPPO_EMBED_DIMENSIONS", () => {
		setRequiredEnv();
		process.env.HIPPO_EMBED_DIMENSIONS = "0";
		expect(() => resolveConfig()).toThrow("Invalid HIPPO_EMBED_DIMENSIONS");
	});

	it("accepts valid HIPPO_EMBED_DIMENSIONS", () => {
		setRequiredEnv();
		process.env.HIPPO_EMBED_DIMENSIONS = "1536";
		const config = resolveConfig();
		expect(config.embedding.dimensions).toBe(1536);
	});
});
