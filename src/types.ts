export type SnapshotSource = "hook" | "statusline" | "watchdog" | "manual";

export interface WindowUsageSnapshot {
  sessionPct?: number;
  weeklyPct?: number;
  weeklySonnetPct?: number;
  sessionResetsInMinutes?: number;
  weeklySonnetResetsInHours?: number;
  weeklySonnetBurnPctPerHour?: number;
  weeklySonnetProjectedEndPct?: number;
  weeklySonnetHitsLimit?: boolean;
}

export interface TokenSnapshot {
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached?: number;
  workloadClass?: "short-context" | "long-context" | "tool-heavy" | "unknown";
}

export interface CcburnSignal {
  percentPerHour: number;
  trend: string;
  estimatedMinutesTo100: number | null;
  recommendation: string;
  sessionResetsInMinutes?: number;
  projectedEndPct?: number;
  hitsLimit?: boolean;
}

export interface SnapshotEvent {
  ts: string;
  source: SnapshotSource;
  token?: TokenSnapshot;
  usage?: WindowUsageSnapshot;
  accounting?: UsageAccountingSnapshot;
  ccburnSignal?: CcburnSignal;
  usageRaw?: unknown;
}

export interface UsageAccountingSnapshot {
  totalTokensCumulative?: number;
  totalCostCumulative?: number;
  sonnetTokensCumulative?: number;
  opusTokensCumulative?: number;
}

export interface AdvisorInput {
  windowMinutes: number;
  now: Date;
  snapshots: SnapshotEvent[];
}

export interface ModelPricePer1M {
  input: number;
  output: number;
  cachedInput?: number;
}

export interface Recommendation {
  recommendedModel: "opus" | "sonnet" | "either";
  confidence: number;
  reason: string[];
  sessionPct?: number;
  sessionBurnPctPerHour?: number;
  timeToLimitMinutes?: number;
  windowResetsInMinutes?: number;
  projectedEndPct?: number;
  willHitLimit?: boolean;
  currentTokensPerPct?: number;
  baselineTokensPerPct?: number;
  pricingVsBaseline?: number;
  isPeak?: boolean;
  weeklySonnetPct?: number;
  weeklySonnetResetsInHours?: number;
  /** Instantaneous burn rate from ccburn's current session measurement. */
  weeklySonnetBurnPctPerHour?: number;
  /** Average burn rate over the current weekly cycle (pct / elapsed hours since reset). */
  weeklySonnetAvgBurnPctPerHour?: number;
  weeklySonnetProjectedEndPct?: number;
  weeklySonnetHitsLimit?: boolean;
  sonnetCapAvailable: boolean;
  sonnetEquivBurnRate?: number;
  sonnetTimeToLimitMinutes?: number;
  dataPoints?: number;
  elapsedMinutes?: number;
  dataSource?: "per-request" | "session-pct" | "accounting" | "ccburn" | "none";
}

export interface PricingHistoryEntry {
  ts: string;
  tokensPerPct: number;
  opusNormalizedTpp: number;
  burnPctPerHour: number;
  opusFraction: number;
  isPeak: boolean;
}

export interface PricingBaseline {
  avgTokensPerPct: number;
  avgBurnPctPerHour: number;
  sampleCount: number;
  isPeak: boolean;
}

export type {
  CandidatePath,
  BindingConstraint,
  CapabilityTier,
  DecisionResult,
  FailureMode,
  ModelId,
  ModelState,
  ObservedState,
  ResetSummary,
  SpendPolicy,
  WorkloadClass,
  WorkloadInference,
} from "./decision-engine/types.js";
