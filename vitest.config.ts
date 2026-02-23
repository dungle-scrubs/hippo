import { defineConfig } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: vitest requires default export
export default defineConfig({
	test: {
		globals: true,
		include: ["src/**/*.test.ts"],
	},
});
