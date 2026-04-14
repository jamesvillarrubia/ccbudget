import type { SnapshotEvent } from "../types.js";
import { evaluateCandidatePaths } from "./evaluate-paths.js";
import { normalizeObservedState } from "./normalize-state.js";
import { inferWorkload } from "./workload-inference.js";
import type { WorkloadInput } from "./workload-inference.js";
import type { DecisionResult, ObservedState, SpendPolicy } from "./types.js";

function recentOpusFraction(snapshots: SnapshotEvent[]): number {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const acct = snapshots[i].accounting;
    if (acct && typeof acct.opusTokensCumulative === "number" && typeof acct.sonnetTokensCumulative === "number") {
      const total = acct.opusTokensCumulative + acct.sonnetTokensCumulative;
      if (total > 0) {
        return acct.opusTokensCumulative / total;
      }
    }
  }
  return 0.5;
}

function burnVolatility(snapshots: SnapshotEvent[]): number {
  const values = snapshots
    .map((snapshot) => snapshot.ccburnSignal?.percentPerHour)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (values.length < 2) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) {
    return 0;
  }

  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function buildWorkloadInput(snapshots: SnapshotEvent[], observedState: ObservedState): WorkloadInput {
  return {
    currentBurnPctPerHour: observedState.currentBurnPctPerHour,
    currentSessionPct: observedState.currentSessionPct,
    resetsInMinutes: observedState.resetsInMinutes,
    recentOpusFraction: recentOpusFraction(snapshots),
    burnVolatility: burnVolatility(snapshots),
  };
}

/**
 * Normalize telemetry, infer workload, and evaluate candidate paths.
 */
export function buildDecisionResult(
  snapshots: SnapshotEvent[],
  policy: SpendPolicy,
): DecisionResult {
  const observedState = normalizeObservedState(snapshots, policy);
  const evaluated = evaluateCandidatePaths(observedState);
  const workloadInference = inferWorkload(buildWorkloadInput(snapshots, observedState));

  return {
    ...evaluated,
    workloadInference,
    confidence: Math.min(0.95, (evaluated.confidence + workloadInference.confidence) / 2),
  };
}
