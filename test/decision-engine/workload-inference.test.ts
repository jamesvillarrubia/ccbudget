import { describe, expect, it } from "vitest";
import { inferWorkload } from "../../src/decision-engine/workload-inference.js";

describe("inferWorkload", () => {
  it("classifies heavy workload from sustained high burn", () => {
    const result = inferWorkload({
      currentBurnPctPerHour: 28,
      currentSessionPct: 70,
      resetsInMinutes: 110,
      recentOpusFraction: 0.9,
      burnVolatility: 0.08,
    });

    expect(result.workload).toBe("heavy");
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("classifies spiky workload from volatile burn", () => {
    const result = inferWorkload({
      currentBurnPctPerHour: 10,
      currentSessionPct: 26,
      resetsInMinutes: 250,
      recentOpusFraction: 0.4,
      burnVolatility: 0.65,
    });

    expect(result.workload).toBe("spiky");
    expect(result.reasons.some((r) => /volatile/i.test(r))).toBe(true);
  });

  it("classifies heavy workload from session pressure even below the burn threshold", () => {
    const result = inferWorkload({
      currentBurnPctPerHour: 12,
      currentSessionPct: 72,
      resetsInMinutes: 150,
      recentOpusFraction: 0.3,
      burnVolatility: 0.1,
    });

    expect(result.workload).toBe("heavy");
    expect(result.reasons.some((r) => /session|reset/i.test(r))).toBe(true);
  });

  it("classifies normal workload from moderate burn without volatility", () => {
    const result = inferWorkload({
      currentBurnPctPerHour: 9,
      currentSessionPct: 24,
      resetsInMinutes: 360,
      recentOpusFraction: 0.2,
      burnVolatility: 0.1,
    });

    expect(result.workload).toBe("normal");
  });

  it("classifies light workload from low sustained burn", () => {
    const result = inferWorkload({
      currentBurnPctPerHour: 3,
      currentSessionPct: 12,
      resetsInMinutes: 480,
      recentOpusFraction: 0.1,
      burnVolatility: 0.05,
    });

    expect(result.workload).toBe("light");
    expect(result.reasons.some((r) => /low/i.test(r))).toBe(true);
  });

  it("falls back to neutral normal workload when burn is missing", () => {
    const result = inferWorkload({
      currentBurnPctPerHour: null,
      currentSessionPct: 12,
      resetsInMinutes: 480,
      recentOpusFraction: 0.2,
      burnVolatility: 0.1,
    });

    expect(result.workload).toBe("normal");
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.reasons.some((r) => /unavailable|neutral/i.test(r))).toBe(true);
  });

  it("ignores non-finite burn, volatility, and Opus mix values", () => {
    const result = inferWorkload({
      currentBurnPctPerHour: Number.NaN,
      currentSessionPct: 12,
      resetsInMinutes: 480,
      recentOpusFraction: Number.POSITIVE_INFINITY,
      burnVolatility: Number.NaN,
    });

    expect(result.workload).toBe("normal");
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.reasons.some((r) => /unavailable|neutral/i.test(r))).toBe(true);
  });
});
