#!/usr/bin/env npx tsx
/**
 * Normalize any image to exact 1280x640 PNG for GitHub social preview.
 * Center-crops to 2:1 aspect ratio, resizes, validates file size.
 *
 * @usage npx tsx scripts/finalize-social-share.ts --input <path> --output <path>
 */
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
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

// Copy to output
execSync(`cp "${input}" "${output}"`);

// Crop to 2:1 aspect ratio
const targetRatio = 2;
const currentRatio = width / height;

if (Math.abs(currentRatio - targetRatio) > 0.01) {
	let cropW: number;
	let cropH: number;
	if (currentRatio > targetRatio) {
		// Too wide — crop width
		cropH = height;
		cropW = Math.floor(height * targetRatio);
	} else {
		// Too tall — crop height
		cropW = width;
		cropH = Math.floor(width / targetRatio);
	}
	const cropX = Math.floor((width - cropW) / 2);
	const cropY = Math.floor((height - cropH) / 2);
	execSync(
		`sips --cropToHeightWidth ${cropH} ${cropW} --cropOffset ${cropY} ${cropX} "${output}"`,
		{ stdio: "pipe" },
	);
}

// Resize to exact 1280x640
execSync(`sips --resampleHeightWidth 640 1280 "${output}"`, { stdio: "pipe" });

// Convert to PNG
execSync(`sips --setProperty format png "${output}"`, { stdio: "pipe" });

// Validate file size
const fileSize = statSync(output).size;
const maxSize = 1024 * 1024; // 1 MB
if (fileSize > maxSize) {
	console.error(`ERROR: File size ${(fileSize / 1024).toFixed(0)}KB exceeds 1MB limit`);
	process.exit(1);
}

console.log(`Social share: ${output} (1280x640 PNG, ${(fileSize / 1024).toFixed(0)}KB)`);
