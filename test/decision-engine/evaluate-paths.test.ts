import { describe, expect, it } from "vitest";
import { classifyFailureModes } from "../../src/decision-engine/classify-failures.js";
import { evaluateCandidatePaths } from "../../src/decision-engine/evaluate-paths.js";
import { isPeakHour } from "../../src/pricing.js";
import type { ObservedState } from "../../src/decision-engine/types.js";

function baseState(overrides: Partial<ObservedState>): ObservedState {
  return {
    currentModel: "sonnet",
    currentSessionPct: 50,
    currentBurnPctPerHour: 10,
    resetsInMinutes: 120,
    weeklySonnetPct: 40,
    weeklySonnetResetsInHours: 48,
    isPeak: false,
    confidence: 0.8,
    policy: {
      allowOverage: false,
      maxHourlyOverageUsd: 0,
      maxWindowOverageUsd: 0,
      preserveCapabilityAbove: { opusToSonnetUsdPerHour: 0, sonnetToHaikuUsdPerHour: 0 },
    },
    ...overrides,
  };
}

describe("evaluateCandidatePaths", () => {
  it("uses current-model semantics for path ids instead of inventing a stay-on-opus path", () => {
    const result = evaluateCandidatePaths(
      baseState({
        currentModel: "sonnet",
        currentSessionPct: 30,
        currentBurnPctPerHour: 5,
        resetsInMinutes: 120,
        weeklySonnetPct: 35,
      }),
    );

    expect(result.recommendedPath?.pathId).toBe("stay-on-sonnet");
    expect(result.viablePaths.map((path) => path.pathId)).not.toContain("stay-on-opus");
  });

  it("uses opus-to-sonnet overage policy when deciding whether to preserve Opus capability", () => {
    const restrictive = evaluateCandidatePaths(
      baseState({
        currentModel: "opus",
        currentSessionPct: 92,
        currentBurnPctPerHour: 5,
        resetsInMinutes: 120,
        weeklySonnetPct: 40,
        policy: {
          allowOverage: true,
          maxHourlyOverageUsd: 10,
          maxWindowOverageUsd: 20,
          preserveCapabilityAbove: {
            opusToSonnetUsdPerHour: 2,
            sonnetToHaikuUsdPerHour: 2,
          },
        },
      }),
    );

    const permissive = evaluateCandidatePaths(
      baseState({
        currentModel: "opus",
        currentSessionPct: 92,
        currentBurnPctPerHour: 5,
        resetsInMinutes: 120,
        weeklySonnetPct: 40,
        policy: {
          allowOverage: true,
          maxHourlyOverageUsd: 10,
          maxWindowOverageUsd: 20,
          preserveCapabilityAbove: {
            opusToSonnetUsdPerHour: 10,
            sonnetToHaikuUsdPerHour: 2,
          },
        },
      }),
    );

    expect(restrictive.recommendedPath?.pathId).toBe("switch-to-sonnet");
    expect(permissive.recommendedPath?.pathId).toBe("continue-on-opus-with-overage");
  });

  it("prefers acceptable Sonnet overage over a Haiku downgrade when policy allows it", () => {
    const result = evaluateCandidatePaths(
      baseState({
        currentModel: "sonnet",
        currentSessionPct: 92,
        currentBurnPctPerHour: 18,
        resetsInMinutes: 120,
        weeklySonnetPct: 95,
        weeklySonnetResetsInHours: 30,
        isPeak: false,
        confidence: 0.8,
        policy: {
          allowOverage: true,
          maxHourlyOverageUsd: 5,
          maxWindowOverageUsd: 12,
          preserveCapabilityAbove: {
            opusToSonnetUsdPerHour: 3,
            sonnetToHaikuUsdPerHour: 2,
          },
        },
      }),
    );

    expect(result.recommendedPath?.pathId).toBe("continue-on-sonnet-with-overage");
  });

  it("falls back to wait-for-reset when neither included nor paid paths fit policy", () => {
    const result = evaluateCandidatePaths(
      baseState({
        currentModel: "opus",
        currentSessionPct: 98,
        currentBurnPctPerHour: 25,
        resetsInMinutes: 40,
        weeklySonnetPct: 95,
        weeklySonnetResetsInHours: 36,
        isPeak: true,
        confidence: 0.8,
        policy: {
          allowOverage: false,
          maxHourlyOverageUsd: 0,
          maxWindowOverageUsd: 0,
          preserveCapabilityAbove: {
            opusToSonnetUsdPerHour: 0,
            sonnetToHaikuUsdPerHour: 0,
          },
        },
      }),
    );

    expect(result.recommendedPath?.pathId).toBe("wait-for-reset");
    expect(result.failureModes).toContain("wait-for-reset-better-than-continuing");
  });

  it("reports the chosen blocking constraint instead of returning the first failure by push order", () => {
    const result = evaluateCandidatePaths(
      baseState({
        currentModel: "opus",
        currentSessionPct: 92,
        currentBurnPctPerHour: 5,
        resetsInMinutes: 120,
        weeklySonnetPct: 40,
        policy: {
          allowOverage: true,
          maxHourlyOverageUsd: 10,
          maxWindowOverageUsd: 20,
          preserveCapabilityAbove: {
            opusToSonnetUsdPerHour: 2,
            sonnetToHaikuUsdPerHour: 2,
          },
        },
      }),
    );

    expect(result.recommendedPath?.pathId).toBe("switch-to-sonnet");
    expect(result.bindingConstraint).toBe("downgrade-required-to-avoid-spend");
  });
});

describe("classifyFailureModes", () => {
  it("classifies Sonnet weekly exhaustion as a current-model cap issue when Sonnet is active", () => {
    const failures = classifyFailureModes(
      baseState({
        currentModel: "sonnet",
        currentSessionPct: 55,
        weeklySonnetPct: 91,
        confidence: 0.45,
        isPeak: true,
      }),
    );

    expect(failures).toContain("current-model-cap-exhaustion");
    expect(failures).not.toContain("fallback-model-cap-exhaustion");
    expect(failures).toContain("peak-hour-distortion");
    expect(failures).toContain("forecast-uncertain");
  });
});

describe("isPeakHour", () => {
  it("evaluates Pacific peak hours from the timestamp instead of parsing locale-dependent strings", () => {
    expect(isPeakHour(new Date("2026-04-13T13:00:00.000Z"))).toBe(true);
    expect(isPeakHour(new Date("2026-04-13T18:30:00.000Z"))).toBe(false);
    expect(isPeakHour(new Date("2026-04-12T13:00:00.000Z"))).toBe(false);
  });
});
