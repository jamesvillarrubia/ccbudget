import { isPeakHour, normalizeToOpusTpp, readPricingFromEnv, weightedUsdPer1MTokens } from "../pricing.js";
import type { PricingBaseline, Recommendation, SnapshotEvent } from "../types.js";
import type { DecisionResult } from "./types.js";

const SONNET_CAP_THRESHOLD = 85;
const DEFAULT_WINDOW_MINUTES = 300;
const WEEKLY_CYCLE_HOURS = 168;
const MIN_ELAPSED_HOURS_FOR_AVG = 6;

interface LegacyAdapterOptions {
  snapshots?: SnapshotEvent[];
  windowMinutes?: number;
  baseline?: PricingBaseline | null;
}

interface BurnRate {
  pctPerHour: number;
  dataPoints: number;
  elapsedMinutes: number;
  source: NonNullable<Recommendation["dataSource"]>;
}

interface CcburnSummary {
  pctPerHour: number;
  minutesTo100: number | null;
  resetsInMinutes?: number;
  projectedEndPct?: number;
  hitsLimit?: boolean;
}

interface WeeklySonnetStatus {
  pct: number;
  resetsInHours?: number;
  burnPctPerHour?: number;
  avgBurnPctPerHour?: number;
  projectedEndPct?: number;
  hitsLimit?: boolean;
}

function getWindowSnapshots(snapshots: SnapshotEvent[], now: Date, minutes: number): SnapshotEvent[] {
  const cutoff = now.getTime() - minutes * 60_000;
  return snapshots.filter((snapshot) => new Date(snapshot.ts).getTime() >= cutoff);
}

function discardPreReset(sorted: SnapshotEvent[]): SnapshotEvent[] {
  let startIdx = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1].usage!.sessionPct!;
    const current = sorted[i].usage!.sessionPct!;
    if (current < prev - 5) {
      startIdx = i;
    }
  }
  return sorted.slice(startIdx);
}

function computeSessionBurnRate(snapshots: SnapshotEvent[], minutes: number, now: Date): BurnRate | null {
  const sorted = getWindowSnapshots(snapshots, now, minutes)
    .filter((snapshot) => typeof snapshot.usage?.sessionPct === "number")
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  if (sorted.length < 2) {
    return null;
  }

  const postReset = discardPreReset(sorted);
  if (postReset.length < 2) {
    return null;
  }

  const first = postReset[0];
  const last = postReset.at(-1)!;
  const elapsedMs = new Date(last.ts).getTime() - new Date(first.ts).getTime();
  const elapsedMinutes = elapsedMs / 60_000;
  if (elapsedMinutes < 1) {
    return null;
  }

  const pctDelta = last.usage!.sessionPct! - first.usage!.sessionPct!;
  return {
    pctPerHour: Math.max(0, (pctDelta / elapsedMinutes) * 60),
    dataPoints: postReset.length,
    elapsedMinutes,
    source: "session-pct",
  };
}

function latestCcburn(snapshots: SnapshotEvent[]): CcburnSummary | undefined {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const signal = snapshots[i].ccburnSignal;
    if (signal && typeof signal.percentPerHour === "number") {
      return {
        pctPerHour: signal.percentPerHour,
        minutesTo100: signal.estimatedMinutesTo100,
        resetsInMinutes: signal.sessionResetsInMinutes,
        projectedEndPct: signal.projectedEndPct,
        hitsLimit: signal.hitsLimit,
      };
    }
  }
  return undefined;
}

function latestResetsInMinutes(snapshots: SnapshotEvent[]): number | undefined {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const signalReset = snapshots[i].ccburnSignal?.sessionResetsInMinutes;
    if (typeof signalReset === "number") {
      return signalReset;
    }
    const usageReset = snapshots[i].usage?.sessionResetsInMinutes;
    if (typeof usageReset === "number") {
      return usageReset;
    }
  }
  return undefined;
}

function latestWeeklySonnet(snapshots: SnapshotEvent[]): WeeklySonnetStatus | undefined {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const usage = snapshots[i].usage;
    const pct = usage?.weeklySonnetPct;
    if (typeof pct === "number") {
      let avgBurnPctPerHour: number | undefined;
      if (usage?.weeklySonnetResetsInHours != null && pct > 0) {
        const elapsedHours = WEEKLY_CYCLE_HOURS - usage.weeklySonnetResetsInHours;
        if (elapsedHours >= MIN_ELAPSED_HOURS_FOR_AVG) {
          avgBurnPctPerHour = pct / elapsedHours;
        }
      }

      return {
        pct,
        resetsInHours: usage?.weeklySonnetResetsInHours,
        burnPctPerHour: usage?.weeklySonnetBurnPctPerHour,
        avgBurnPctPerHour,
        projectedEndPct: usage?.weeklySonnetProjectedEndPct,
        hitsLimit: usage?.weeklySonnetHitsLimit,
      };
    }
  }
  return undefined;
}

function computeWeeklySonnetProjection(
  status: WeeklySonnetStatus | undefined,
): Pick<Recommendation, "weeklySonnetProjectedEndPct" | "weeklySonnetHitsLimit"> {
  if (!status || status.resetsInHours == null) {
    return {
      weeklySonnetProjectedEndPct: status?.projectedEndPct,
      weeklySonnetHitsLimit: status?.hitsLimit,
    };
  }

  const rate = status.avgBurnPctPerHour ?? status.burnPctPerHour;
  if (rate == null || rate <= 0) {
    return {
      weeklySonnetProjectedEndPct: status.projectedEndPct,
      weeklySonnetHitsLimit: status.hitsLimit,
    };
  }

  const projectedPct = Math.min(100, status.pct + rate * status.resetsInHours);
  return {
    weeklySonnetProjectedEndPct: projectedPct,
    weeklySonnetHitsLimit: projectedPct >= 100,
  };
}

function estimateTokensPerPct(snapshots: SnapshotEvent[]): number | null {
  const sorted = snapshots
    .filter((snapshot) =>
      typeof snapshot.accounting?.totalTokensCumulative === "number"
      && typeof snapshot.usage?.sessionPct === "number")
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  if (sorted.length < 2) {
    return null;
  }

  const postReset = discardPreReset(sorted);
  if (postReset.length < 2) {
    return null;
  }

  const first = postReset[0];
  const last = postReset.at(-1)!;
  const tokenDelta = last.accounting!.totalTokensCumulative! - first.accounting!.totalTokensCumulative!;
  const pctDelta = last.usage!.sessionPct! - first.usage!.sessionPct!;
  if (pctDelta <= 0 || tokenDelta <= 0) {
    return null;
  }

  return tokenDelta / pctDelta;
}

function estimateModelMix(snapshots: SnapshotEvent[]): { opusFraction: number; sonnetFraction: number } {
  for (let i = snapshots.length - 1; i >= 0; i -= 1) {
    const accounting = snapshots[i].accounting;
    if (
      accounting
      && typeof accounting.opusTokensCumulative === "number"
      && typeof accounting.sonnetTokensCumulative === "number"
    ) {
      const total = accounting.opusTokensCumulative + accounting.sonnetTokensCumulative;
      if (total > 0) {
        return {
          opusFraction: accounting.opusTokensCumulative / total,
          sonnetFraction: accounting.sonnetTokensCumulative / total,
        };
      }
    }
  }

  return { opusFraction: 0.5, sonnetFraction: 0.5 };
}

function estimateSonnetBurnRate(
  currentBurnRate: number,
  mix: { opusFraction: number; sonnetFraction: number },
): number {
  const prices = readPricingFromEnv();
  const opusWeighted = weightedUsdPer1MTokens(prices.opus);
  const sonnetWeighted = weightedUsdPer1MTokens(prices.sonnet);
  const currentWeighted = mix.opusFraction * opusWeighted + mix.sonnetFraction * sonnetWeighted;
  if (currentWeighted <= 0) {
    return currentBurnRate;
  }
  return currentBurnRate * (sonnetWeighted / currentWeighted);
}

function deriveBurnRate(snapshots: SnapshotEvent[], windowMinutes: number, now: Date): BurnRate | null {
  const sessionBurn =
    computeSessionBurnRate(snapshots, windowMinutes, now)
    ?? computeSessionBurnRate(snapshots, 120, now)
    ?? computeSessionBurnRate(snapshots, 30, now);
  const ccburn = latestCcburn(snapshots);

  if (sessionBurn && sessionBurn.pctPerHour > 0) {
    return sessionBurn;
  }
  if (ccburn && ccburn.pctPerHour > 0) {
    return {
      pctPerHour: ccburn.pctPerHour,
      dataPoints: 1,
      elapsedMinutes: 0,
      source: "ccburn",
    };
  }
  if (sessionBurn) {
    return sessionBurn;
  }
  return null;
}

function mapPathToLegacyModel(result: DecisionResult): Recommendation["recommendedModel"] {
  if (result.observedState.currentModel === null) {
    return "either";
  }

  const path = result.recommendedPath;
  if (!path?.model || path.pathId === "wait-for-reset") {
    return "either";
  }
  if (path.model === "opus") {
    return "opus";
  }
  if (path.model === "sonnet") {
    return "sonnet";
  }
  if (path.model === "haiku") {
    return "either";
  }
  return "either";
}

/**
 * Map a decision-engine result into the legacy `Recommendation` shape used by the CLI.
 */
export function toLegacyRecommendation(
  result: DecisionResult,
  options: LegacyAdapterOptions = {},
): Recommendation {
  const snapshots = options.snapshots ?? [];
  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const baseline = options.baseline;
  const now = snapshots.length > 0 ? new Date(snapshots.at(-1)!.ts) : new Date();

  const burnRate = deriveBurnRate(snapshots, windowMinutes, now);
  const ccburn = latestCcburn(snapshots);
  const currentPct = result.observedState.currentSessionPct ?? undefined;
  const resetsIn = ccburn?.resetsInMinutes ?? result.resets.sessionMinutes ?? latestResetsInMinutes(snapshots);

  let timeToLimitMinutes: number | undefined;
  if (ccburn?.minutesTo100 != null && ccburn.minutesTo100 > 0) {
    timeToLimitMinutes = Math.round(ccburn.minutesTo100);
  } else if (burnRate && burnRate.pctPerHour > 0 && currentPct != null) {
    timeToLimitMinutes = Math.round(((100 - currentPct) / burnRate.pctPerHour) * 60);
  }

  const projectedEndPct = ccburn?.projectedEndPct
    ?? (burnRate && burnRate.pctPerHour > 0 && currentPct != null && resetsIn != null
      ? Math.min(100, currentPct + burnRate.pctPerHour * (resetsIn / 60))
      : undefined);

  const mix = estimateModelMix(snapshots);
  const tokensPerPct = estimateTokensPerPct(snapshots);
  const currentNormalizedTpp = tokensPerPct != null
    ? normalizeToOpusTpp(tokensPerPct, mix.opusFraction)
    : undefined;
  const baselineTokensPerPct = baseline?.avgTokensPerPct;
  const pricingVsBaseline =
    currentNormalizedTpp != null && baselineTokensPerPct != null && baselineTokensPerPct > 0
      ? Number((((baselineTokensPerPct - currentNormalizedTpp) / baselineTokensPerPct) * 100).toFixed(1))
      : undefined;

  let sonnetEquivBurnRate: number | undefined;
  let sonnetTimeToLimitMinutes: number | undefined;
  if (burnRate && burnRate.pctPerHour > 0 && currentPct != null) {
    sonnetEquivBurnRate = Number(estimateSonnetBurnRate(burnRate.pctPerHour, mix).toFixed(1));
    if (sonnetEquivBurnRate > 0) {
      sonnetTimeToLimitMinutes = Math.round(((100 - currentPct) / sonnetEquivBurnRate) * 60);
    }
  }

  const weeklySonnet = latestWeeklySonnet(snapshots);
  const weeklyProjection = computeWeeklySonnetProjection(weeklySonnet);
  const willHitLimit =
    typeof ccburn?.hitsLimit === "boolean"
      ? ccburn.hitsLimit
      : timeToLimitMinutes != null && resetsIn != null
        ? timeToLimitMinutes < resetsIn
        : result.failureModes.includes("current-model-window-exhaustion");
  const legacyReasons = result.recommendedPath?.model === "haiku"
    ? [`Legacy output degraded Haiku recommendation to either (${result.recommendedPath.pathId}).`, ...result.workloadInference.reasons, ...result.explanation]
    : [...result.workloadInference.reasons, ...result.explanation];

  return {
    recommendedModel: mapPathToLegacyModel(result),
    confidence: result.confidence,
    reason: legacyReasons,
    sessionPct: currentPct,
    sessionBurnPctPerHour: burnRate?.pctPerHour ?? 0,
    timeToLimitMinutes,
    windowResetsInMinutes: resetsIn ?? undefined,
    projectedEndPct: projectedEndPct != null ? Math.round(projectedEndPct) : undefined,
    willHitLimit,
    currentTokensPerPct: tokensPerPct != null ? Math.round(tokensPerPct) : undefined,
    baselineTokensPerPct: baselineTokensPerPct != null ? Math.round(baselineTokensPerPct) : undefined,
    pricingVsBaseline,
    isPeak: isPeakHour(now),
    weeklySonnetPct: result.observedState.weeklySonnetPct ?? weeklySonnet?.pct,
    weeklySonnetResetsInHours: result.resets.weeklySonnetHours ?? weeklySonnet?.resetsInHours,
    weeklySonnetBurnPctPerHour: weeklySonnet?.burnPctPerHour,
    weeklySonnetAvgBurnPctPerHour: weeklySonnet?.avgBurnPctPerHour,
    weeklySonnetProjectedEndPct: weeklyProjection.weeklySonnetProjectedEndPct,
    weeklySonnetHitsLimit: weeklyProjection.weeklySonnetHitsLimit,
    sonnetCapAvailable: (result.observedState.weeklySonnetPct ?? 0) < SONNET_CAP_THRESHOLD,
    sonnetEquivBurnRate,
    sonnetTimeToLimitMinutes,
    dataPoints: burnRate?.dataPoints,
    elapsedMinutes: burnRate && burnRate.elapsedMinutes > 0 ? Math.round(burnRate.elapsedMinutes) : undefined,
    dataSource: burnRate?.source ?? "none",
  };
}
