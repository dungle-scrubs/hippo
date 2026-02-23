/** Default decay constant λ. */
const LAMBDA = 0.001;

/** Retrieval boost added to running_intensity on each access. */
const RETRIEVAL_BOOST = 0.02;

/** Minimum effective strength — below this, chunks are excluded from results. */
export const STRENGTH_FLOOR = 0.05;

/** Scoring weights. */
export const WEIGHTS = {
	recency: 0.1,
	similarity: 0.6,
	strength: 0.3,
} as const;

/**
 * Compute decay resistance from access count.
 *
 * Frequently recalled memories decay slower.
 *
 * @param accessCount - Number of times this chunk was accessed
 * @returns Decay resistance multiplier (≥1.0)
 */
export function decayResistance(accessCount: number): number {
	return 1 + Math.log(1 + accessCount) * 0.3;
}

/**
 * Compute effective strength after time decay.
 *
 * @param runningIntensity - Current running intensity [0, 1]
 * @param accessCount - Total access count
 * @param hoursSinceLastAccess - Hours since last access
 * @returns Effective strength [0, 1]
 */
export function effectiveStrength(
	runningIntensity: number,
	accessCount: number,
	hoursSinceLastAccess: number,
): number {
	const resistance = decayResistance(accessCount);
	return runningIntensity * Math.exp((-LAMBDA / resistance) * hoursSinceLastAccess);
}

/**
 * Compute recency score based on days since creation.
 *
 * @param daysSinceCreation - Days since the chunk was created
 * @returns Recency score [0, 1], exponentially decaying
 */
export function recencyScore(daysSinceCreation: number): number {
	return Math.exp(-0.01 * daysSinceCreation);
}

/**
 * Compute composite search score combining similarity, strength, and recency.
 *
 * @param similarity - Cosine similarity [0, 1]
 * @param strength - Effective strength [0, 1]
 * @param recency - Recency score [0, 1]
 * @returns Weighted composite score
 */
export function searchScore(similarity: number, strength: number, recency: number): number {
	return WEIGHTS.similarity * similarity + WEIGHTS.strength * strength + WEIGHTS.recency * recency;
}

/**
 * Update running intensity via moving average after reinforcement.
 *
 * @param oldIntensity - Current running intensity
 * @param encounterCount - Current encounter count (before increment)
 * @param newReading - Intensity of the new encounter
 * @returns Updated running intensity
 */
export function updatedIntensity(
	oldIntensity: number,
	encounterCount: number,
	newReading: number,
): number {
	return (oldIntensity * encounterCount + newReading) / (encounterCount + 1);
}

/**
 * Apply retrieval boost to running intensity.
 *
 * @param runningIntensity - Current running intensity
 * @returns Boosted intensity, clamped to 1.0
 */
export function retrievalBoost(runningIntensity: number): number {
	return Math.min(1.0, runningIntensity + RETRIEVAL_BOOST);
}
