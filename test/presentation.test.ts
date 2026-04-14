import { describe, expect, it } from "vitest";
import type { DecisionResult, Recommendation } from "../src/types.js";
import { buildAdvisorJsonPayload, formatDecisionSummary } from "../src/presentation.js";

function makeDecisionResult(overrides: Partial<DecisionResult> = {}): DecisionResult {
  return {
    observedState: {
      currentModel: "sonnet",
      currentSessionPct: 93,
      currentBurnPctPerHour: 18,
      resetsInMinutes: 90,
      weeklySonnetPct: 88,
      weeklySonnetResetsInHours: 24,
      isPeak: false,
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
    },
    workloadInference: {
      workload: "heavy",
      confidence: 0.7,
      reasons: ["high sustained burn"],
    },
    failureModes: ["current-model-window-exhaustion"],
    bindingConstraint: "current-model-window-exhaustion",
    viablePaths: [],
    recommendedPath: {
      pathId: "switch-to-sonnet",
      model: "sonnet",
      capabilityTier: 2,
      fitsIncludedUsage: true,
      fitsSpendPolicy: true,
      projectedRunwayMinutes: 120,
      projectedWindowOverageUsd: 0,
      projectedHourlyOverageUsd: 0,
      accepted: true,
      reason: ["Included usage survives the window"],
    },
    overageAlternatives: [],
    resets: {
      sessionMinutes: 90,
      weeklySonnetHours: 24,
    },
    confidence: 0.75,
    explanation: ["Included usage survives the window"],
    ...overrides,
  };
}

function makeRecommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    recommendedModel: "sonnet",
    confidence: 0.75,
    reason: ["Switch to Sonnet to survive the session window."],
    sessionPct: 93,
    sessionBurnPctPerHour: 18,
    timeToLimitMinutes: 24,
    windowResetsInMinutes: 90,
    projectedEndPct: 100,
    willHitLimit: true,
    sonnetCapAvailable: true,
    ...overrides,
  };
}

describe("formatDecisionSummary", () => {
  it("renders the failure mode, binding constraint, and recommended path", () => {
    const decision = makeDecisionResult();

    const output = formatDecisionSummary(decision);

    expect(output).toContain("Failure mode: current-model-window-exhaustion");
    expect(output).toContain("Binding constraint: current-model-window-exhaustion");
    expect(output).toContain("Recommended path: switch-to-sonnet");
  });

  it("renders meaningful fallback text when no path is recommended", () => {
    const output = formatDecisionSummary(
      makeDecisionResult({
        failureModes: [],
        bindingConstraint: null,
        recommendedPath: null,
        explanation: [],
      }),
    );

    expect(output).toContain("Failure modes: none");
    expect(output).toContain("Binding constraint: none");
    expect(output).toContain("Recommended path: none");
    expect(output).not.toContain("Notes:");
  });

  it("renders projected overage and notes when present", () => {
    const output = formatDecisionSummary(
      makeDecisionResult({
        recommendedPath: {
          pathId: "stay-on-opus-with-overage",
          model: "opus",
          capabilityTier: 3,
          fitsIncludedUsage: false,
          fitsSpendPolicy: true,
          projectedRunwayMinutes: 240,
          projectedWindowOverageUsd: 4.25,
          projectedHourlyOverageUsd: 1.75,
          accepted: true,
          reason: ["Overage remains within policy."],
        },
        explanation: ["Overage stays under the window cap.", "Capability is preserved."],
      }),
    );

    expect(output).toContain("Projected overage: $4.25 this window");
    expect(output).toContain("Notes:");
    expect(output).toContain("  - Overage stays under the window cap.");
    expect(output).toContain("  - Capability is preserved.");
  });
});

describe("buildAdvisorJsonPayload", () => {
  it("intentionally preserves both decision and legacy recommendation in json output", () => {
    const decision = makeDecisionResult();
    const recommendation = makeRecommendation();

    const payload = buildAdvisorJsonPayload({
      windowMinutes: 300,
      decision,
      recommendation,
    });

    expect(payload).toEqual({
      ok: true,
      windowMinutes: 300,
      decision,
      recommendation,
    });
    expect(payload.decision.recommendedPath?.pathId).toBe("switch-to-sonnet");
    expect(payload.recommendation.recommendedModel).toBe("sonnet");
  });
});
