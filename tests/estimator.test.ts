import { describe, it, expect } from "vitest";
import { buildRecommendation } from "../src/estimator.js";
import type { PricingBaseline, SnapshotEvent } from "../src/types.js";

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

  it("still delegates through the decision engine when the current model is known but burn is missing", () => {
    const snap: SnapshotEvent = {
      ts: new Date().toISOString(),
      source: "manual",
      token: {
        model: "claude-opus-4",
        tokensIn: 1200,
        tokensOut: 300,
      },
      usage: {
        sessionPct: 10,
        sessionResetsInMinutes: 240,
        weeklySonnetPct: 20,
        weeklySonnetResetsInHours: 72,
      },
    };

    const result = buildRecommendation([snap], 300);

    expect(result.recommendedModel).toBe("opus");
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.dataSource).toBe("none");
    expect(result.sessionBurnPctPerHour).toBe(0);
  });

  it("preserves derived legacy fields used by the CLI and pricing history path", () => {
    const baseline: PricingBaseline = {
      avgTokensPerPct: 30_000,
      avgBurnPctPerHour: 8,
      sampleCount: 12,
      isPeak: false,
    };

    const snapshots: SnapshotEvent[] = [
      {
        ts: "2026-04-13T16:00:00.000Z",
        source: "manual",
        token: {
          model: "claude-opus-4",
          tokensIn: 1000,
          tokensOut: 250,
        },
        usage: {
          sessionPct: 40,
          sessionResetsInMinutes: 240,
          weeklySonnetPct: 40,
          weeklySonnetResetsInHours: 48,
          weeklySonnetBurnPctPerHour: 0.4,
        },
        accounting: {
          totalTokensCumulative: 500_000,
          opusTokensCumulative: 300_000,
          sonnetTokensCumulative: 100_000,
        },
      },
      {
        ts: "2026-04-13T18:00:00.000Z",
        source: "manual",
        token: {
          model: "claude-opus-4",
          tokensIn: 1200,
          tokensOut: 300,
        },
        usage: {
          sessionPct: 60,
          sessionResetsInMinutes: 240,
          weeklySonnetPct: 40,
          weeklySonnetResetsInHours: 48,
          weeklySonnetBurnPctPerHour: 0.4,
          weeklySonnetProjectedEndPct: 99,
          weeklySonnetHitsLimit: true,
        },
        accounting: {
          totalTokensCumulative: 900_000,
          opusTokensCumulative: 600_000,
          sonnetTokensCumulative: 200_000,
        },
        ccburnSignal: {
          percentPerHour: 12,
          trend: "up",
          estimatedMinutesTo100: 180,
          recommendation: "switch",
          sessionResetsInMinutes: 240,
          projectedEndPct: 95,
          hitsLimit: true,
        },
      },
    ];

    const result = buildRecommendation(snapshots, 300, baseline);

    expect(result.sessionPct).toBe(60);
    expect(result.sessionBurnPctPerHour).toBe(10);
    expect(result.timeToLimitMinutes).toBe(180);
    expect(result.windowResetsInMinutes).toBe(240);
    expect(result.projectedEndPct).toBe(95);
    expect(result.willHitLimit).toBe(true);
    expect(result.currentTokensPerPct).toBe(20_000);
    expect(result.baselineTokensPerPct).toBe(30_000);
    expect(result.pricingVsBaseline).toBeCloseTo(46.7, 1);
    expect(result.weeklySonnetPct).toBe(40);
    expect(result.weeklySonnetResetsInHours).toBe(48);
    expect(result.weeklySonnetBurnPctPerHour).toBe(0.4);
    expect(result.weeklySonnetAvgBurnPctPerHour).toBeCloseTo(40 / 120, 3);
    expect(result.weeklySonnetProjectedEndPct).toBeCloseTo(56, 0);
    expect(result.weeklySonnetHitsLimit).toBe(false);
    expect(result.sonnetCapAvailable).toBe(true);
    expect(result.dataSource).toBe("session-pct");
  });

  it("degrades a Haiku recommendation truthfully to either", () => {
    const snapshots: SnapshotEvent[] = [
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
    ];

    const result = buildRecommendation(snapshots, 300);

    expect(result.recommendedModel).toBe("either");
    expect(result.reason.some((reason) => /downgrade|capability|wait|selected/i.test(reason))).toBe(true);
  });
});
