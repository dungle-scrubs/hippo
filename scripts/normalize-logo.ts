#!/usr/bin/env npx tsx
/**
 * Normalize any image to exact 1000x1000 PNG.
 * Center-crops if not square, then resizes.
 *
 * @usage npx tsx scripts/normalize-logo.ts --input <path> --output <path>
 */
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
	options: {
		input: { type: "string" },
		output: { type: "string" },
	},
});

if (!values.input || !values.output) {
	console.error("Usage: --input <path> --output <path>");
	process.exit(1);
}

const input = values.input;
const output = values.output;

// Get current dimensions
const info = execSync(`sips -g pixelWidth -g pixelHeight "${input}"`, { encoding: "utf-8" });
const width = Number(info.match(/pixelWidth:\s*(\d+)/)?.[1]);
const height = Number(info.match(/pixelHeight:\s*(\d+)/)?.[1]);

if (!width || !height) {
	console.error("Could not read image dimensions");
	process.exit(1);
}

// Center-crop to square
const size = Math.min(width, height);
const cropX = Math.floor((width - size) / 2);
const cropY = Math.floor((height - size) / 2);

// Copy to output first
execSync(`cp "${input}" "${output}"`);

if (width !== height) {
	execSync(`sips --cropToHeightWidth ${size} ${size} --cropOffset ${cropY} ${cropX} "${output}"`, {
		stdio: "pipe",
	});
}

// Resize to exact 1000x1000
execSync(`sips --resampleHeightWidth 1000 1000 "${output}"`, { stdio: "pipe" });

// Convert to PNG
execSync(`sips --setProperty format png "${output}"`, { stdio: "pipe" });

console.log(`Normalized: ${output} (1000x1000 PNG)`);
