import { describe, it, expect } from "vitest";
import { buildRecommendation } from "../src/estimator.js";
import type { SnapshotEvent } from "../src/types.js";

describe("buildRecommendation", () => {
  it("returns either/idle with no data", () => {
    const result = buildRecommendation([], 300);
    expect(result.recommendedModel).toBe("either");
    expect(result.sessionBurnPctPerHour).toBe(0);
    expect(result.willHitLimit).toBe(false);
    expect(result.sonnetCapAvailable).toBe(true);
  });

  it("returns either with insufficient data points", () => {
    const snap: SnapshotEvent = {
      ts: new Date().toISOString(),
      source: "manual",
      usage: { sessionPct: 10 },
    };
    const result = buildRecommendation([snap], 300);
    expect(result.recommendedModel).toBe("either");
    expect(result.confidence).toBeLessThan(0.5);
  });
});
