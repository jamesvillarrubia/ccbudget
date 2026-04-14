import { describe, expect, it } from "vitest";
import { buildDecisionResult } from "../../src/decision-engine/index.js";

describe("buildDecisionResult", () => {
  it("returns a structured recommendation with viable paths and a binding constraint", () => {
    const result = buildDecisionResult(
      [
        {
          ts: "2026-04-12T20:00:00.000Z",
          source: "manual",
          token: {
            model: "claude-sonnet-4-5",
            tokensIn: 1000,
            tokensOut: 300,
            tokensCached: 0,
            workloadClass: "tool-heavy",
          },
          usage: {
            sessionPct: 93,
            sessionResetsInMinutes: 120,
            weeklySonnetPct: 82,
            weeklySonnetResetsInHours: 28,
          },
          ccburnSignal: {
            percentPerHour: 18,
            trend: "up",
            estimatedMinutesTo100: 24,
            recommendation: "switch",
            sessionResetsInMinutes: 120,
            projectedEndPct: 100,
            hitsLimit: true,
          },
        },
      ],
      {
        allowOverage: false,
        maxHourlyOverageUsd: 0,
        maxWindowOverageUsd: 0,
        preserveCapabilityAbove: {
          opusToSonnetUsdPerHour: 0,
          sonnetToHaikuUsdPerHour: 0,
        },
      },
    );

    expect(result.observedState.currentModel).toBe("sonnet");
    expect(result.failureModes).toContain("current-model-window-exhaustion");
    expect(result.viablePaths.length).toBeGreaterThan(1);
    expect(result.recommendedPath?.pathId).toBe("switch-to-haiku");
    expect(result.bindingConstraint).toBeTruthy();
    expect(result.explanation.length).toBeGreaterThan(0);
  });
});
