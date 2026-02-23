/**
 * Minimal ULID generator (Crockford Base32, 48-bit timestamp + 80-bit random).
 *
 * No external dependency needed — ULIDs are just encoded timestamps with randomness.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Encode a number into Crockford Base32 of exactly `len` characters.
 *
 * @param value - Non-negative integer to encode
 * @param len - Output string length (zero-padded)
 * @returns Crockford Base32 string
 */
function encodeBase32(value: number, len: number): string {
	let result = "";
	for (let i = len - 1; i >= 0; i--) {
		result = ENCODING[value & 0x1f] + result;
		value = Math.floor(value / 32);
	}
	return result;
}

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier).
 *
 * @param timestamp - Optional timestamp in ms (defaults to Date.now())
 * @returns 26-character ULID string
 */
export function ulid(timestamp?: number): string {
	const ts = timestamp ?? Date.now();
	const timePart = encodeBase32(ts, 10);

	// 16 random chars × 5 bits = 80 bits of randomness
	const randomBytes = crypto.getRandomValues(new Uint8Array(16));
	let randomPart = "";
	for (const byte of randomBytes) {
		randomPart += ENCODING[byte & 0x1f];
	}

	return timePart + randomPart;
}
