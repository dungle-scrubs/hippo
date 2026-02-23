import { describe, expect, it } from "vitest";
import {
	decayResistance,
	effectiveStrength,
	recencyScore,
	retrievalBoost,
	STRENGTH_FLOOR,
	searchScore,
	updatedIntensity,
} from "./strength.js";

describe("decayResistance", () => {
	it("returns 1.0 for zero access count", () => {
		expect(decayResistance(0)).toBeCloseTo(1.0, 5);
	});

	it("increases with access count", () => {
		expect(decayResistance(5)).toBeGreaterThan(decayResistance(0));
		expect(decayResistance(20)).toBeGreaterThan(decayResistance(5));
		expect(decayResistance(100)).toBeGreaterThan(decayResistance(20));
	});

	it("matches documented half-life values", () => {
		expect(decayResistance(5)).toBeCloseTo(1.54, 1);
		expect(decayResistance(20)).toBeCloseTo(1.91, 1);
		expect(decayResistance(100)).toBeCloseTo(2.38, 1);
	});
});

describe("effectiveStrength", () => {
	it("returns running intensity when no time has elapsed", () => {
		expect(effectiveStrength(0.8, 5, 0)).toBeCloseTo(0.8, 5);
	});

	it("decays over time", () => {
		const initial = effectiveStrength(0.8, 0, 0);
		const later = effectiveStrength(0.8, 0, 24 * 30);
		expect(later).toBeLessThan(initial);
	});

	it("decays slower with higher access count", () => {
		const hours = 24 * 30; // 30 days
		const lowAccess = effectiveStrength(0.8, 0, hours);
		const highAccess = effectiveStrength(0.8, 50, hours);
		expect(highAccess).toBeGreaterThan(lowAccess);
	});

	it("returns 0 for zero intensity regardless of other params", () => {
		expect(effectiveStrength(0, 100, 0)).toBe(0);
	});
});

describe("recencyScore", () => {
	it("returns 1.0 for day 0", () => {
		expect(recencyScore(0)).toBeCloseTo(1.0, 5);
	});

	it("returns ~0.74 for 30 days", () => {
		expect(recencyScore(30)).toBeCloseTo(0.74, 1);
	});

	it("returns ~0.03 for 365 days", () => {
		expect(recencyScore(365)).toBeCloseTo(0.026, 1);
	});

	it("monotonically decreases", () => {
		let prev = recencyScore(0);
		for (let d = 1; d <= 100; d++) {
			const curr = recencyScore(d);
			expect(curr).toBeLessThan(prev);
			prev = curr;
		}
	});
});

describe("searchScore", () => {
	it("weights similarity highest", () => {
		const highSim = searchScore(1.0, 0, 0);
		const highStr = searchScore(0, 1.0, 0);
		const highRec = searchScore(0, 0, 1.0);
		expect(highSim).toBeGreaterThan(highStr);
		expect(highStr).toBeGreaterThan(highRec);
	});

	it("sums to 1.0 for all-ones input", () => {
		expect(searchScore(1.0, 1.0, 1.0)).toBeCloseTo(1.0, 5);
	});
});

describe("updatedIntensity", () => {
	it("returns new reading for first encounter", () => {
		// encounter_count=1 (first encounter), adding a second reading
		expect(updatedIntensity(0.5, 1, 0.9)).toBeCloseTo(0.7, 5);
	});

	it("converges to the average over many encounters", () => {
		let intensity = 0.5;
		for (let i = 1; i <= 100; i++) {
			intensity = updatedIntensity(intensity, i, 0.8);
		}
		expect(intensity).toBeCloseTo(0.8, 1);
	});

	it("early readings have high influence", () => {
		const early = updatedIntensity(0.5, 1, 0.9);
		const late = updatedIntensity(0.5, 100, 0.9);
		// Early reading moves the average more
		expect(Math.abs(early - 0.5)).toBeGreaterThan(Math.abs(late - 0.5));
	});
});

describe("retrievalBoost", () => {
	it("adds 0.02 to intensity", () => {
		expect(retrievalBoost(0.5)).toBeCloseTo(0.52, 5);
	});

	it("clamps to 1.0", () => {
		expect(retrievalBoost(0.99)).toBe(1.0);
		expect(retrievalBoost(1.0)).toBe(1.0);
	});
});

describe("STRENGTH_FLOOR", () => {
	it("is 0.05", () => {
		expect(STRENGTH_FLOOR).toBe(0.05);
	});
});
