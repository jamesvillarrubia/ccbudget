import { readSpendPolicyFromEnv } from "./config.js";
import { buildDecisionResult } from "./decision-engine/index.js";
import { toLegacyRecommendation } from "./decision-engine/legacy-adapter.js";
import type { PricingBaseline, Recommendation, SnapshotEvent } from "./types.js";

export function estimateModelMix(snapshots: SnapshotEvent[]): { opusFraction: number; sonnetFraction: number } {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const acct = snapshots[i].accounting;
    if (acct && typeof acct.opusTokensCumulative === "number" && typeof acct.sonnetTokensCumulative === "number") {
      const total = acct.opusTokensCumulative + acct.sonnetTokensCumulative;
      if (total > 0) {
        return {
          opusFraction: acct.opusTokensCumulative / total,
          sonnetFraction: acct.sonnetTokensCumulative / total,
        };
      }
    }
  }

  return { opusFraction: 0.5, sonnetFraction: 0.5 };
}

export function buildRecommendation(
  snapshots: SnapshotEvent[],
  windowMinutes = 300,
  baseline?: PricingBaseline | null,
): Recommendation {
  const policy = readSpendPolicyFromEnv();
  const result = buildDecisionResult(snapshots, policy);
  return toLegacyRecommendation(result, { snapshots, windowMinutes, baseline });
}
