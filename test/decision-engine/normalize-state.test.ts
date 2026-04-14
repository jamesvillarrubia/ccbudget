import { describe, expect, it } from "vitest";
import { normalizeObservedState } from "../../src/decision-engine/normalize-state.js";

const conservativePolicy = {
  allowOverage: false,
  maxHourlyOverageUsd: 0,
  maxWindowOverageUsd: 0,
  preserveCapabilityAbove: { opusToSonnetUsdPerHour: 0, sonnetToHaikuUsdPerHour: 0 },
} as const;

describe("normalizeObservedState", () => {
  it("maps the latest snapshots into a stable observed state", () => {
    const state = normalizeObservedState(
      [
        {
          ts: "2026-04-12T20:00:00.000Z",
          source: "manual",
          token: {
            model: "claude-opus-4-1",
            tokensIn: 1000,
            tokensOut: 300,
            tokensCached: 500,
            workloadClass: "tool-heavy",
          },
          usage: {
            sessionPct: 64,
            sessionResetsInMinutes: 90,
            weeklySonnetPct: 12,
            weeklySonnetResetsInHours: 88,
          },
          accounting: { totalTokensCumulative: 250000, opusTokensCumulative: 190000, sonnetTokensCumulative: 60000 },
        },
      ],
      conservativePolicy,
    );

    expect(state.currentModel).toBe("opus");
    expect(state.currentSessionPct).toBe(64);
    expect(state.resetsInMinutes).toBe(90);
    expect(state.weeklySonnetPct).toBe(12);
    expect(state.weeklySonnetResetsInHours).toBe(88);
    expect(state.policy).toEqual(conservativePolicy);
  });

  it("uses the newest usable values when the last snapshot is sparse", () => {
    const state = normalizeObservedState(
      [
        {
          ts: "2026-04-12T19:00:00.000Z",
          source: "hook",
          token: { model: "claude-sonnet-4-5", tokensIn: 100, tokensOut: 50 },
          usage: {
            sessionPct: 10,
            sessionResetsInMinutes: 200,
            weeklySonnetPct: 5,
            weeklySonnetResetsInHours: 100,
          },
          ccburnSignal: {
            percentPerHour: 9,
            trend: "flat",
            estimatedMinutesTo100: 600,
            recommendation: "ok",
            sessionResetsInMinutes: 180,
          },
        },
        {
          ts: "2026-04-12T19:30:00.000Z",
          source: "hook",
          usage: {
            sessionPct: 40,
            weeklySonnetPct: 12,
            weeklySonnetResetsInHours: 88,
          },
          ccburnSignal: {
            percentPerHour: 14,
            trend: "up",
            estimatedMinutesTo100: 257,
            recommendation: "watch",
            sessionResetsInMinutes: 95,
          },
        },
        {
          ts: "2026-04-12T20:00:00.000Z",
          source: "manual",
          token: { model: "claude-opus-4-1", tokensIn: 1000, tokensOut: 300 },
          usage: {
            sessionPct: 64,
            sessionResetsInMinutes: Number.NaN,
          },
          ccburnSignal: {
            percentPerHour: Number.POSITIVE_INFINITY,
            trend: "up",
            estimatedMinutesTo100: 100,
            recommendation: "switch",
          },
        },
      ],
      conservativePolicy,
    );

    expect(state.currentModel).toBe("opus");
    expect(state.currentSessionPct).toBe(64);
    expect(state.currentBurnPctPerHour).toBe(14);
    expect(state.resetsInMinutes).toBe(95);
    expect(state.weeklySonnetPct).toBe(12);
    expect(state.weeklySonnetResetsInHours).toBe(88);
  });

  it("uses ccburn reset and burn signals when usage omits session reset (matches estimator precedence)", () => {
    const state = normalizeObservedState(
      [
        {
          ts: "2026-04-12T20:00:00.000Z",
          source: "manual",
          token: { model: "claude-haiku-3", tokensIn: 1, tokensOut: 1 },
          usage: { sessionPct: 30, weeklySonnetPct: 0, weeklySonnetResetsInHours: 120 },
          ccburnSignal: {
            percentPerHour: 12,
            trend: "flat",
            estimatedMinutesTo100: 50,
            recommendation: "ok",
            sessionResetsInMinutes: 95,
          },
        },
      ],
      conservativePolicy,
    );

    expect(state.currentModel).toBe("haiku");
    expect(state.currentBurnPctPerHour).toBe(12);
    expect(state.resetsInMinutes).toBe(95);
  });

  it("returns low confidence without ccburn or accounting-backed mix data", () => {
    const state = normalizeObservedState(
      [
        {
          ts: "2026-04-12T20:00:00.000Z",
          source: "manual",
          token: { model: "claude-sonnet-4-5", tokensIn: 100, tokensOut: 50 },
          usage: {
            sessionPct: 22,
            sessionResetsInMinutes: 240,
            weeklySonnetPct: 9,
            weeklySonnetResetsInHours: 100,
          },
        },
      ],
      conservativePolicy,
    );

    expect(state.confidence).toBe(0.25);
  });

  it("returns an empty normalized state for empty input", () => {
    const state = normalizeObservedState([], conservativePolicy);

    expect(state.currentModel).toBeNull();
    expect(state.currentSessionPct).toBeNull();
    expect(state.currentBurnPctPerHour).toBeNull();
    expect(state.resetsInMinutes).toBeNull();
    expect(state.weeklySonnetPct).toBeNull();
    expect(state.weeklySonnetResetsInHours).toBeNull();
    expect(state.confidence).toBe(0.25);
  });
});
