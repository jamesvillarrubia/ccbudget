import { isPeakHour, normalizeToOpusTpp, readPricingFromEnv } from "./pricing.js";
import type { PricingBaseline, Recommendation, SnapshotEvent } from "./types.js";

const SESSION_WINDOW_HOURS = 5;

function getWindowSnapshots(snapshots: SnapshotEvent[], now: Date, minutes: number): SnapshotEvent[] {
  const cutoff = now.getTime() - minutes * 60_000;
  return snapshots.filter((s) => new Date(s.ts).getTime() >= cutoff);
}

function discardPreReset(sorted: SnapshotEvent[]): SnapshotEvent[] {
  let startIdx = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1].usage!.sessionPct!;
    const curr = sorted[i].usage!.sessionPct!;
    if (curr < prev - 5) startIdx = i;
  }
  return sorted.slice(startIdx);
}

interface BurnRate {
  pctPerHour: number;
  dataPoints: number;
  elapsedMinutes: number;
  source: "session-pct" | "ccburn" | "accounting" | "none";
}

function computeSessionBurnRate(snapshots: SnapshotEvent[], minutes: number, now: Date): BurnRate | null {
  const sorted = getWindowSnapshots(snapshots, now, minutes)
    .filter((s) => typeof s.usage?.sessionPct === "number")
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  if (sorted.length < 2) return null;
  const postReset = discardPreReset(sorted);
  if (postReset.length < 2) return null;
  const first = postReset[0];
  const last = postReset.at(-1)!;
  const elapsedMs = new Date(last.ts).getTime() - new Date(first.ts).getTime();
  const elapsedMinutes = elapsedMs / 60_000;
  if (elapsedMinutes < 1) return null;
  const pctDelta = last.usage!.sessionPct! - first.usage!.sessionPct!;
  const pctPerHour = Math.max(0, (pctDelta / elapsedMinutes) * 60);
  return { pctPerHour, dataPoints: postReset.length, elapsedMinutes, source: "session-pct" };
}

function latestSessionPct(snapshots: SnapshotEvent[]): number | undefined {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (typeof snapshots[i].usage?.sessionPct === "number") return snapshots[i].usage!.sessionPct;
  }
  return undefined;
}

interface CcburnSummary {
  pctPerHour: number;
  minutesTo100: number | null;
  resetsInMinutes?: number;
  projectedEndPct?: number;
  hitsLimit?: boolean;
}

function latestCcburn(snapshots: SnapshotEvent[]): CcburnSummary | undefined {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const sig = snapshots[i].ccburnSignal;
    if (sig && typeof sig.percentPerHour === "number") {
      return {
        pctPerHour: sig.percentPerHour,
        minutesTo100: sig.estimatedMinutesTo100,
        resetsInMinutes: sig.sessionResetsInMinutes,
        projectedEndPct: sig.projectedEndPct,
        hitsLimit: sig.hitsLimit,
      };
    }
  }
  return undefined;
}

function latestResetsInMinutes(snapshots: SnapshotEvent[]): number | undefined {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const sig = snapshots[i].ccburnSignal;
    if (typeof sig?.sessionResetsInMinutes === "number") return sig.sessionResetsInMinutes;
    const usage = snapshots[i].usage;
    if (typeof usage?.sessionResetsInMinutes === "number") return usage.sessionResetsInMinutes;
  }
  return undefined;
}

const WEEKLY_CYCLE_HOURS = 168; // 7 days
const MIN_ELAPSED_HOURS_FOR_AVG = 6;

interface WeeklySonnetStatus {
  pct: number;
  resetsInHours?: number;
  /** Instantaneous rate from ccburn. */
  burnPctPerHour?: number;
  /** Average rate over the current weekly cycle: pct / elapsed hours since reset. */
  avgBurnPctPerHour?: number;
  projectedEndPct?: number;
  hitsLimit?: boolean;
}

function latestWeeklySonnet(snapshots: SnapshotEvent[]): WeeklySonnetStatus | undefined {
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const u = snapshots[i].usage;
    const pct = u?.weeklySonnetPct;
    if (typeof pct === "number") {
      let avgBurnPctPerHour: number | undefined;
      if (u?.weeklySonnetResetsInHours != null && pct > 0) {
        const elapsedHours = WEEKLY_CYCLE_HOURS - u.weeklySonnetResetsInHours;
        if (elapsedHours >= MIN_ELAPSED_HOURS_FOR_AVG) {
          avgBurnPctPerHour = pct / elapsedHours;
        }
      }
      return {
        pct,
        resetsInHours: u?.weeklySonnetResetsInHours,
        burnPctPerHour: u?.weeklySonnetBurnPctPerHour,
        avgBurnPctPerHour,
        projectedEndPct: u?.weeklySonnetProjectedEndPct,
        hitsLimit: u?.weeklySonnetHitsLimit,
      };
    }
  }
  return undefined;
}

const SONNET_CAP_THRESHOLD = 85;

function estimateTokensPerPct(snapshots: SnapshotEvent[]): number | null {
  const sorted = snapshots
    .filter((s) => typeof s.accounting?.totalTokensCumulative === "number" && typeof s.usage?.sessionPct === "number")
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  if (sorted.length < 2) return null;
  const postReset = discardPreReset(sorted);
  if (postReset.length < 2) return null;
  const first = postReset[0];
  const last = postReset.at(-1)!;
  const tokenDelta = last.accounting!.totalTokensCumulative! - first.accounting!.totalTokensCumulative!;
  const pctDelta = last.usage!.sessionPct! - first.usage!.sessionPct!;
  if (pctDelta <= 0 || tokenDelta <= 0) return null;
  return tokenDelta / pctDelta;
}

export function estimateModelMix(snapshots: SnapshotEvent[]): { opusFraction: number; sonnetFraction: number } {
  for (let i = snapshots.length - 1; i >= 0; i--) {
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

function estimateSonnetBurnRate(
  currentBurnRate: number,
  mix: { opusFraction: number; sonnetFraction: number },
): number {
  const prices = readPricingFromEnv();
  const opusWeightedCost = prices.opus.input * 0.6 + prices.opus.output * 0.3 + (prices.opus.cachedInput ?? prices.opus.input) * 0.1;
  const sonnetWeightedCost = prices.sonnet.input * 0.6 + prices.sonnet.output * 0.3 + (prices.sonnet.cachedInput ?? prices.sonnet.input) * 0.1;
  const currentWeightedCost = mix.opusFraction * opusWeightedCost + mix.sonnetFraction * sonnetWeightedCost;
  if (currentWeightedCost <= 0) return currentBurnRate;
  const scaleFactor = sonnetWeightedCost / currentWeightedCost;
  return currentBurnRate * scaleFactor;
}

/**
 * Recompute weekly Sonnet projection using the best available rate:
 * prefer the weekly average (which includes idle hours, sleep, etc.)
 * over the instantaneous ccburn rate (which only reflects right now).
 */
function computeWeeklySonnetProjection(
  sonnetStatus: WeeklySonnetStatus | undefined,
): { weeklySonnetProjectedEndPct?: number; weeklySonnetHitsLimit?: boolean } {
  if (!sonnetStatus || sonnetStatus.resetsInHours == null) {
    return {
      weeklySonnetProjectedEndPct: sonnetStatus?.projectedEndPct,
      weeklySonnetHitsLimit: sonnetStatus?.hitsLimit,
    };
  }

  const rate = sonnetStatus.avgBurnPctPerHour ?? sonnetStatus.burnPctPerHour;
  if (rate == null || rate <= 0) {
    return {
      weeklySonnetProjectedEndPct: sonnetStatus.projectedEndPct,
      weeklySonnetHitsLimit: sonnetStatus.hitsLimit,
    };
  }

  const projectedPct = Math.min(100, sonnetStatus.pct + rate * sonnetStatus.resetsInHours);
  return {
    weeklySonnetProjectedEndPct: projectedPct,
    weeklySonnetHitsLimit: projectedPct >= 100,
  };
}

export function buildRecommendation(
  snapshots: SnapshotEvent[],
  windowMinutes = 300,
  baseline?: PricingBaseline | null,
): Recommendation {
  const now = new Date();
  const reasons: string[] = [];
  const currentPct = latestSessionPct(snapshots);

  const sessionBurn = computeSessionBurnRate(snapshots, windowMinutes, now)
    ?? computeSessionBurnRate(snapshots, 120, now)
    ?? computeSessionBurnRate(snapshots, 30, now);

  const ccburn = latestCcburn(snapshots);

  let burnRate: BurnRate | null = null;
  if (sessionBurn && sessionBurn.pctPerHour > 0) {
    burnRate = sessionBurn;
  } else if (ccburn && ccburn.pctPerHour > 0) {
    burnRate = {
      pctPerHour: ccburn.pctPerHour,
      dataPoints: 1,
      elapsedMinutes: 0,
      source: "ccburn",
    };
  } else if (sessionBurn) {
    burnRate = sessionBurn;
  }

  const pctRemaining = 100 - (currentPct ?? 0);
  const resetsIn = ccburn?.resetsInMinutes ?? latestResetsInMinutes(snapshots);
  let timeToLimitMinutes: number | undefined;

  if (ccburn?.minutesTo100 != null && ccburn.minutesTo100 > 0) {
    timeToLimitMinutes = ccburn.minutesTo100;
  } else if (burnRate && burnRate.pctPerHour > 0) {
    timeToLimitMinutes = (pctRemaining / burnRate.pctPerHour) * 60;
  }

  let willHitLimit: boolean;
  if (typeof ccburn?.hitsLimit === "boolean") {
    willHitLimit = ccburn.hitsLimit;
  } else if (resetsIn != null && timeToLimitMinutes != null) {
    willHitLimit = timeToLimitMinutes < resetsIn;
  } else {
    willHitLimit = timeToLimitMinutes != null && timeToLimitMinutes < SESSION_WINDOW_HOURS * 60;
  }

  const projectedEndPct = ccburn?.projectedEndPct;

  const tokensPerPct = estimateTokensPerPct(snapshots);
  const mix = estimateModelMix(snapshots);

  const currentNormalizedTpp = tokensPerPct != null
    ? normalizeToOpusTpp(tokensPerPct, mix.opusFraction)
    : undefined;
  const baselineTokensPerPct = baseline?.avgTokensPerPct;

  let pricingVsBaseline: number | undefined;
  if (currentNormalizedTpp != null && baselineTokensPerPct != null && baselineTokensPerPct > 0) {
    pricingVsBaseline = ((baselineTokensPerPct - currentNormalizedTpp) / baselineTokensPerPct) * 100;
  }

  const sonnetStatus = latestWeeklySonnet(snapshots);
  const sonnetCapAvailable = sonnetStatus == null || sonnetStatus.pct < SONNET_CAP_THRESHOLD;

  let sonnetEquivBurnRate: number | undefined;
  let sonnetTimeToLimitMinutes: number | undefined;

  if (burnRate && burnRate.pctPerHour > 0) {
    sonnetEquivBurnRate = estimateSonnetBurnRate(burnRate.pctPerHour, mix);
    if (sonnetEquivBurnRate > 0) {
      sonnetTimeToLimitMinutes = (pctRemaining / sonnetEquivBurnRate) * 60;
    }
  }

  if (typeof currentPct === "number") {
    reasons.push(`Session: ${currentPct}%`);
  }

  let confidence = 0.1;

  if (!burnRate || burnRate.pctPerHour === 0) {
    reasons.push("No active burn detected — idle or insufficient data.");
    return {
      recommendedModel: "either",
      confidence: 0.2,
      reason: reasons,
      sessionPct: currentPct,
      sessionBurnPctPerHour: 0,
      windowResetsInMinutes: resetsIn,
      projectedEndPct: currentPct,
      willHitLimit: false,
      weeklySonnetPct: sonnetStatus?.pct,
      weeklySonnetResetsInHours: sonnetStatus?.resetsInHours,
      weeklySonnetBurnPctPerHour: sonnetStatus?.burnPctPerHour,
      weeklySonnetAvgBurnPctPerHour: sonnetStatus?.avgBurnPctPerHour,
      weeklySonnetProjectedEndPct: sonnetStatus?.projectedEndPct,
      weeklySonnetHitsLimit: sonnetStatus?.hitsLimit,
      sonnetCapAvailable,
      dataSource: burnRate?.source ?? "none",
    };
  }

  reasons.push(`Burn rate: ${burnRate.pctPerHour.toFixed(1)}%/hr`);

  if (burnRate.source === "session-pct" && burnRate.elapsedMinutes > 0) {
    reasons.push(`${burnRate.dataPoints} samples over ${burnRate.elapsedMinutes.toFixed(0)}min`);
  }

  if (baseline) {
    reasons.push(`Your avg burn: ${baseline.avgBurnPctPerHour.toFixed(1)}%/hr (${baseline.sampleCount} historical samples)`);
  }

  if (resetsIn != null) {
    const hrs = resetsIn / 60;
    reasons.push(`Window resets in ${hrs.toFixed(1)}h`);
  }

  if (timeToLimitMinutes != null) {
    const hrs = timeToLimitMinutes / 60;
    reasons.push(`Time to 100%: ${hrs.toFixed(1)}h`);
  }

  if (projectedEndPct != null) {
    reasons.push(`ccburn projects ${projectedEndPct.toFixed(0)}% at window end`);
  }

  if (tokensPerPct != null) {
    const label = tokensPerPct > 1_000_000
      ? `${(tokensPerPct / 1_000_000).toFixed(1)}M`
      : tokensPerPct > 1_000 ? `${(tokensPerPct / 1_000).toFixed(0)}K` : `${tokensPerPct.toFixed(0)}`;
    reasons.push(`1% = ~${label} tokens`);
  }

  if (pricingVsBaseline != null) {
    const dir = pricingVsBaseline > 0 ? "more expensive" : "cheaper";
    reasons.push(`Pricing: ${Math.abs(pricingVsBaseline).toFixed(0)}% ${dir} than your avg`);
  }

  if (sonnetEquivBurnRate != null && sonnetTimeToLimitMinutes != null) {
    const sonnetHrs = sonnetTimeToLimitMinutes / 60;
    const sonnetEndPct = (currentPct ?? 0) + sonnetEquivBurnRate * SESSION_WINDOW_HOURS;
    reasons.push(`On Sonnet: ~${sonnetEquivBurnRate.toFixed(1)}%/hr → ${Math.min(100, sonnetEndPct).toFixed(0)}% at window end (~${sonnetHrs.toFixed(1)}h to 100%)`);
  }

  reasons.push(`Mix: ${(mix.opusFraction * 100).toFixed(0)}% Opus / ${(mix.sonnetFraction * 100).toFixed(0)}% Sonnet`);

  if (sonnetStatus != null) {
    reasons.push(`Weekly Sonnet: ${sonnetStatus.pct}%${sonnetStatus.resetsInHours != null ? ` (resets in ${sonnetStatus.resetsInHours.toFixed(0)}h)` : ""}`);
    if (!sonnetCapAvailable) {
      reasons.push(`⚠ Sonnet weekly cap nearly exhausted — cannot rely on Sonnet as fallback.`);
    }
  }

  let recommendedModel: Recommendation["recommendedModel"] = "either";
  const sonnetSurvives = sonnetTimeToLimitMinutes != null && sonnetTimeToLimitMinutes >= SESSION_WINDOW_HOURS * 60;

  if (willHitLimit) {
    if (!sonnetCapAvailable) {
      recommendedModel = "either";
      reasons.push("Budget tight and Sonnet cap nearly exhausted — pace yourself on Opus or wait for window reset.");
    } else if (timeToLimitMinutes != null && timeToLimitMinutes < 60) {
      recommendedModel = "sonnet";
      reasons.push("DANGER: <1h to budget limit — switch to Sonnet now.");
    } else if (timeToLimitMinutes != null && timeToLimitMinutes < 180) {
      recommendedModel = "sonnet";
      reasons.push(sonnetSurvives
        ? "Tight budget — switch to Sonnet to survive the window."
        : "Tight budget — switch to Sonnet to extend runway.");
    } else {
      recommendedModel = "sonnet";
      reasons.push(sonnetSurvives
        ? "On track to hit limit — Sonnet would keep you under budget."
        : "On track to hit limit — Sonnet extends your runway.");
    }
  } else {
    if (pricingVsBaseline != null && pricingVsBaseline > 20) {
      reasons.push("Pricing is elevated — budget burns faster than usual.");
      recommendedModel = "either";
    } else if (pricingVsBaseline != null && pricingVsBaseline < -10) {
      reasons.push("Pricing is favorable — good window for Opus.");
      recommendedModel = "opus";
    } else {
      reasons.push("You have headroom — Opus is fine.");
      recommendedModel = "opus";
    }
  }

  const pts = burnRate.dataPoints;
  if (burnRate.source === "session-pct") {
    confidence = pts >= 10 ? 0.8 : pts >= 6 ? 0.7 : pts >= 3 ? 0.55 : 0.35;
  } else {
    confidence = 0.35;
  }
  if (baseline && baseline.sampleCount >= 10) confidence = Math.min(confidence + 0.1, 0.95);

  return {
    recommendedModel,
    confidence,
    reason: reasons,
    sessionPct: currentPct,
    sessionBurnPctPerHour: burnRate.pctPerHour,
    timeToLimitMinutes: timeToLimitMinutes != null ? Math.round(timeToLimitMinutes) : undefined,
    windowResetsInMinutes: resetsIn,
    projectedEndPct: projectedEndPct ?? (burnRate.pctPerHour > 0 && resetsIn != null
      ? Math.min(100, (currentPct ?? 0) + burnRate.pctPerHour * (resetsIn / 60))
      : undefined),
    willHitLimit,
    currentTokensPerPct: tokensPerPct != null ? Math.round(tokensPerPct) : undefined,
    baselineTokensPerPct: baselineTokensPerPct != null ? Math.round(baselineTokensPerPct) : undefined,
    pricingVsBaseline: pricingVsBaseline != null ? Number(pricingVsBaseline.toFixed(1)) : undefined,
    isPeak: isPeakHour(now),
    weeklySonnetPct: sonnetStatus?.pct,
    weeklySonnetResetsInHours: sonnetStatus?.resetsInHours,
    weeklySonnetBurnPctPerHour: sonnetStatus?.burnPctPerHour,
    weeklySonnetAvgBurnPctPerHour: sonnetStatus?.avgBurnPctPerHour,
    ...computeWeeklySonnetProjection(sonnetStatus),
    sonnetCapAvailable,
    sonnetEquivBurnRate: sonnetEquivBurnRate != null ? Number(sonnetEquivBurnRate.toFixed(1)) : undefined,
    sonnetTimeToLimitMinutes: sonnetTimeToLimitMinutes != null ? Math.round(sonnetTimeToLimitMinutes) : undefined,
    dataPoints: burnRate.dataPoints,
    elapsedMinutes: burnRate.elapsedMinutes > 0 ? Math.round(burnRate.elapsedMinutes) : undefined,
    dataSource: burnRate.source,
  };
}
