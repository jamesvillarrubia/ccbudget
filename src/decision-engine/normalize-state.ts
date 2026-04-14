import { isPeakHour } from "../pricing.js";
import type { SnapshotEvent } from "../types.js";
import type { ModelId, ObservedState, SpendPolicy } from "./types.js";

function inferCurrentModel(modelName: string | undefined): ModelId | null {
  const lower = String(modelName ?? "").toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function latestValue<T>(snapshots: SnapshotEvent[], pick: (snapshot: SnapshotEvent) => T | null): T | null {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const value = pick(snapshots[i]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function latestCurrentModel(snapshots: SnapshotEvent[]): ModelId | null {
  return latestValue(snapshots, (snapshot) => inferCurrentModel(snapshot.token?.model));
}

function latestSessionPct(snapshots: SnapshotEvent[]): number | null {
  return latestValue(snapshots, (snapshot) => finiteNumber(snapshot.usage?.sessionPct));
}

function latestBurnPctPerHour(snapshots: SnapshotEvent[]): number | null {
  return latestValue(snapshots, (snapshot) => finiteNumber(snapshot.ccburnSignal?.percentPerHour));
}

function latestResetsInMinutes(snapshots: SnapshotEvent[]): number | null {
  return latestValue(snapshots, (snapshot) => {
    const ccburnReset = finiteNumber(snapshot.ccburnSignal?.sessionResetsInMinutes);
    if (ccburnReset !== null) {
      return ccburnReset;
    }
    return finiteNumber(snapshot.usage?.sessionResetsInMinutes);
  });
}

function latestWeeklySonnetPct(snapshots: SnapshotEvent[]): number | null {
  return latestValue(snapshots, (snapshot) => finiteNumber(snapshot.usage?.weeklySonnetPct));
}

function latestWeeklySonnetResetsInHours(snapshots: SnapshotEvent[]): number | null {
  return latestValue(snapshots, (snapshot) => finiteNumber(snapshot.usage?.weeklySonnetResetsInHours));
}

function hasAccountingBackedMix(snapshots: SnapshotEvent[]): boolean {
  return snapshots.some((snapshot) => {
    const opus = finiteNumber(snapshot.accounting?.opusTokensCumulative);
    const sonnet = finiteNumber(snapshot.accounting?.sonnetTokensCumulative);

    return opus !== null && sonnet !== null && opus + sonnet > 0;
  });
}

export function normalizeObservedState(snapshots: SnapshotEvent[], policy: SpendPolicy): ObservedState {
  const latest = snapshots.at(-1);

  if (!latest) {
    return {
      currentModel: null,
      currentSessionPct: null,
      currentBurnPctPerHour: null,
      resetsInMinutes: null,
      weeklySonnetPct: null,
      weeklySonnetResetsInHours: null,
      isPeak: isPeakHour(new Date()),
      confidence: 0.25,
      policy,
    };
  }

  const now = new Date(latest.ts);
  const confidence = latestBurnPctPerHour(snapshots) !== null
    ? 0.7
    : hasAccountingBackedMix(snapshots)
      ? 0.5
      : 0.25;

  return {
    currentModel: latestCurrentModel(snapshots),
    currentSessionPct: latestSessionPct(snapshots),
    currentBurnPctPerHour: latestBurnPctPerHour(snapshots),
    resetsInMinutes: latestResetsInMinutes(snapshots),
    weeklySonnetPct: latestWeeklySonnetPct(snapshots),
    weeklySonnetResetsInHours: latestWeeklySonnetResetsInHours(snapshots),
    isPeak: isPeakHour(now),
    confidence,
    policy,
  };
}
