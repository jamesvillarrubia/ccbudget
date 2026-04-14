export type ModelId = "opus" | "sonnet" | "haiku";
export type CapabilityTier = 3 | 2 | 1;
export type WorkloadClass = "light" | "normal" | "heavy" | "spiky";

export type FailureMode =
  | "current-model-window-exhaustion"
  | "current-model-cap-exhaustion"
  | "fallback-model-cap-exhaustion"
  | "global-included-budget-exhaustion"
  | "acceptable-overage-preserves-capability"
  | "downgrade-required-to-avoid-spend"
  | "wait-for-reset-better-than-continuing"
  | "no-viable-high-capability-path"
  | "forecast-uncertain"
  | "peak-hour-distortion";

export type BindingConstraint = FailureMode;

export interface SpendPolicy {
  allowOverage: boolean;
  maxHourlyOverageUsd: number;
  maxWindowOverageUsd: number;
  preserveCapabilityAbove: {
    opusToSonnetUsdPerHour: number;
    sonnetToHaikuUsdPerHour: number;
  };
}

export interface ModelState {
  model: ModelId;
  capabilityTier: CapabilityTier;
  available: boolean;
  includedViable: boolean;
  overageViable: boolean;
  projectedWindowOverageUsd: number;
  projectedHourlyOverageUsd: number;
  projectedRunwayMinutes: number | null;
  rejectionReason?: string;
}

export interface ObservedState {
  currentModel: ModelId | null;
  currentSessionPct: number | null;
  currentBurnPctPerHour: number | null;
  resetsInMinutes: number | null;
  weeklySonnetPct: number | null;
  weeklySonnetResetsInHours: number | null;
  isPeak: boolean;
  confidence: number;
  policy: SpendPolicy;
}

export interface WorkloadInference {
  workload: WorkloadClass;
  confidence: number;
  reasons: string[];
}

export interface CandidatePath {
  pathId: string;
  model: ModelId | null;
  capabilityTier: CapabilityTier | 0;
  fitsIncludedUsage: boolean;
  fitsSpendPolicy: boolean;
  projectedRunwayMinutes: number | null;
  projectedWindowOverageUsd: number;
  projectedHourlyOverageUsd: number;
  accepted: boolean;
  reason: string[];
}

export interface ResetSummary {
  sessionMinutes: number | null;
  weeklySonnetHours: number | null;
}

export interface DecisionResult {
  observedState: ObservedState;
  workloadInference: WorkloadInference;
  failureModes: FailureMode[];
  bindingConstraint: BindingConstraint | null;
  viablePaths: CandidatePath[];
  recommendedPath: CandidatePath | null;
  overageAlternatives: CandidatePath[];
  resets: ResetSummary;
  confidence: number;
  explanation: string[];
}
