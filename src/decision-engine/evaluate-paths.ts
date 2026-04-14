import { estimateOverageUsd } from "../pricing.js";
import type { CandidatePath, DecisionResult, FailureMode, ModelId, ObservedState } from "./types.js";
import { classifyFailureModes } from "./classify-failures.js";

const TOKENS_PER_PCT_PER_HOUR = 40_000;
const WEEKLY_INCLUDED_HEADROOM_PCT = 90;
const BURN_MULTIPLIER_BY_MODEL: Record<ModelId, number> = {
  opus: 1,
  sonnet: 0.3,
  haiku: 0.15,
};

function capabilityTier(model: ModelId | null): 3 | 2 | 1 | 0 {
  if (model === "opus") return 3;
  if (model === "sonnet") return 2;
  if (model === "haiku") return 1;
  return 0;
}

function usesWeeklySonnetBudget(model: ModelId | null): boolean {
  return model === "sonnet" || model === "haiku";
}

function stayPathId(model: ModelId | null): string | null {
  return model ? `stay-on-${model}` : null;
}

function overagePathId(model: ModelId | null): string | null {
  return model ? `continue-on-${model}-with-overage` : null;
}

function downgradeTargets(currentModel: ModelId | null): ModelId[] {
  switch (currentModel) {
    case "opus":
      return ["sonnet", "haiku"];
    case "sonnet":
      return ["haiku"];
    case "haiku":
      return [];
    default:
      return ["opus", "sonnet", "haiku"];
  }
}

function weeklyAllowsIncludedSonnetPool(state: ObservedState): boolean {
  return (state.weeklySonnetPct ?? 0) < WEEKLY_INCLUDED_HEADROOM_PCT;
}

function projectedRunwayMinutes(
  state: ObservedState,
  burnMultiplier: number,
): number | null {
  const burn = state.currentBurnPctPerHour;
  const session = state.currentSessionPct;
  if (burn == null || burn <= 0 || session == null) {
    return null;
  }
  const remainingPct = Math.max(0, 100 - session);
  const effectiveBurn = burn * burnMultiplier;
  if (effectiveBurn <= 0) {
    return null;
  }
  return Math.round((remainingPct / effectiveBurn) * 60);
}

function buildPath(
  pathId: string,
  model: ModelId | null,
  burnMultiplier: number,
  state: ObservedState,
  options: {
    forceIncludedUsage?: boolean;
    compareAgainstDowngrade?: ModelId | null;
    compareAgainstIncludedViable?: boolean;
    allowPaidContinuation?: boolean;
  } = {},
): CandidatePath {
  const runway = projectedRunwayMinutes(state, burnMultiplier);
  const resets = state.resetsInMinutes ?? 0;
  const tokensPerHour = (state.currentBurnPctPerHour ?? 0) * TOKENS_PER_PCT_PER_HOUR;
  const overagePerHour = model ? estimateOverageUsd(model, tokensPerHour) : 0;
  const overageForWindow = overagePerHour * (resets / 60);

  const weeklyOk = !usesWeeklySonnetBudget(model) || weeklyAllowsIncludedSonnetPool(state);
  const runwayOk = runway == null ? true : runway >= resets;
  let fitsIncludedUsage = weeklyOk && runwayOk;
  if (options.forceIncludedUsage === true) {
    fitsIncludedUsage = true;
  }
  if (options.forceIncludedUsage === false) {
    fitsIncludedUsage = false;
  }

  const withinHardSpendCaps =
    options.allowPaidContinuation === true &&
    state.policy.allowOverage &&
    overagePerHour <= state.policy.maxHourlyOverageUsd &&
    overageForWindow <= state.policy.maxWindowOverageUsd;

  const preserveCapabilityThreshold =
    model === "opus" && options.compareAgainstDowngrade === "sonnet"
      ? state.policy.preserveCapabilityAbove.opusToSonnetUsdPerHour
      : model === "sonnet" && options.compareAgainstDowngrade === "haiku"
        ? state.policy.preserveCapabilityAbove.sonnetToHaikuUsdPerHour
        : null;

  const preserveCapabilityAboveDowngrade =
    fitsIncludedUsage ||
    preserveCapabilityThreshold == null ||
    !options.compareAgainstIncludedViable ||
    overagePerHour <= preserveCapabilityThreshold;

  const fitsSpendPolicy =
    fitsIncludedUsage ||
    (withinHardSpendCaps && preserveCapabilityAboveDowngrade);

  return {
    pathId,
    model,
    capabilityTier: capabilityTier(model),
    fitsIncludedUsage,
    fitsSpendPolicy,
    projectedRunwayMinutes: runway,
    projectedWindowOverageUsd: Number(overageForWindow.toFixed(2)),
    projectedHourlyOverageUsd: Number(overagePerHour.toFixed(2)),
    accepted: false,
    reason: [],
  };
}

function pickBest(paths: CandidatePath[], preferIncludedOnTie: boolean): CandidatePath | null {
  if (paths.length === 0) {
    return null;
  }
  return paths.reduce((best, path) => {
    if (path.capabilityTier > best.capabilityTier) {
      return path;
    }
    if (path.capabilityTier < best.capabilityTier) {
      return best;
    }
    if (preferIncludedOnTie) {
      if (best.fitsIncludedUsage && !path.fitsIncludedUsage) {
        return best;
      }
      if (!best.fitsIncludedUsage && path.fitsIncludedUsage) {
        return path;
      }
    } else if (path.pathId.includes("with-overage") && !best.pathId.includes("with-overage")) {
      return path;
    }
    return best;
  });
}

function selectRecommendedPath(candidates: CandidatePath[]): CandidatePath | null {
  const waitPath = candidates.find((path) => path.pathId === "wait-for-reset") ?? null;
  const modelPaths = candidates.filter((path) => path.model !== null);

  const includedViable = modelPaths.filter((path) => path.fitsIncludedUsage && path.fitsSpendPolicy);
  const paidViable = modelPaths.filter((path) => !path.fitsIncludedUsage && path.fitsSpendPolicy);

  const bestIncluded = pickBest(includedViable, true);
  const bestPaid = pickBest(paidViable, false);

  if (bestPaid && bestIncluded) {
    if (bestPaid.capabilityTier > bestIncluded.capabilityTier) {
      return bestPaid;
    }
    return bestIncluded;
  }
  if (bestIncluded) {
    return bestIncluded;
  }
  if (bestPaid) {
    return bestPaid;
  }

  if (waitPath) {
    return waitPath;
  }
  return null;
}

function inferBindingConstraint(
  state: ObservedState,
  failures: FailureMode[],
  recommended: CandidatePath | null,
  candidates: CandidatePath[],
): FailureMode | null {
  if (!recommended) {
    return failures[0] ?? null;
  }

  const currentStayPathId = stayPathId(state.currentModel);
  const currentOveragePathId = overagePathId(state.currentModel);
  const currentOveragePath = currentOveragePathId
    ? candidates.find((path) => path.pathId === currentOveragePathId) ?? null
    : null;

  if (recommended.pathId === "wait-for-reset") {
    if (failures.includes("global-included-budget-exhaustion")) {
      return "global-included-budget-exhaustion";
    }
    return "wait-for-reset-better-than-continuing";
  }

  if (recommended.pathId === currentOveragePathId) {
    return "acceptable-overage-preserves-capability";
  }

  if (recommended.pathId !== currentStayPathId && recommended.model !== null && recommended.model !== state.currentModel) {
    if (currentOveragePath && !currentOveragePath.fitsSpendPolicy) {
      return "downgrade-required-to-avoid-spend";
    }
    if (failures.includes("current-model-cap-exhaustion")) {
      return "current-model-cap-exhaustion";
    }
    if (failures.includes("current-model-window-exhaustion")) {
      return "current-model-window-exhaustion";
    }
    if (failures.includes("fallback-model-cap-exhaustion")) {
      return "fallback-model-cap-exhaustion";
    }
    return "no-viable-high-capability-path";
  }

  return null;
}

export function evaluateCandidatePaths(state: ObservedState): DecisionResult {
  const failures = classifyFailureModes(state);
  const currentModel = state.currentModel;
  const currentStayPathId = stayPathId(currentModel);
  const currentOveragePathId = overagePathId(currentModel);
  const targets = downgradeTargets(currentModel);

  const currentStayPath = currentModel && currentStayPathId
    ? buildPath(currentStayPathId, currentModel, BURN_MULTIPLIER_BY_MODEL[currentModel], state)
    : null;

  const downgradePaths = targets.map((model) =>
    buildPath(`switch-to-${model}`, model, BURN_MULTIPLIER_BY_MODEL[model], state),
  );

  const preferredDowngrade = downgradePaths.find((path) => path.fitsIncludedUsage && path.fitsSpendPolicy)
    ?? downgradePaths[0]
    ?? null;

  const currentOveragePath =
    currentModel && currentOveragePathId
      ? buildPath(currentOveragePathId, currentModel, BURN_MULTIPLIER_BY_MODEL[currentModel], state, {
          forceIncludedUsage: false,
          compareAgainstDowngrade: preferredDowngrade?.model ?? null,
          compareAgainstIncludedViable: Boolean(preferredDowngrade?.fitsIncludedUsage && preferredDowngrade?.fitsSpendPolicy),
          allowPaidContinuation: true,
        })
      : null;

  const candidates: CandidatePath[] = [
    ...(currentStayPath ? [currentStayPath] : []),
    ...(currentOveragePath ? [currentOveragePath] : []),
    ...downgradePaths,
    {
      ...buildPath("wait-for-reset", null, 0, state),
      fitsIncludedUsage: true,
      fitsSpendPolicy: true,
      projectedRunwayMinutes: state.resetsInMinutes,
      projectedWindowOverageUsd: 0,
      projectedHourlyOverageUsd: 0,
    },
  ];

  const recommended = selectRecommendedPath(candidates);

  if (recommended) {
    recommended.accepted = true;
    recommended.reason.push("Selected using capability-first policy: included, then acceptable overage, then downgrade, then wait");
  }

  const derivedFailureModes: FailureMode[] = [];
  if (recommended?.pathId === "wait-for-reset") {
    derivedFailureModes.push("wait-for-reset-better-than-continuing");
  } else if (recommended?.pathId === currentOveragePathId) {
    derivedFailureModes.push("acceptable-overage-preserves-capability");
  }

  const bindingConstraint = inferBindingConstraint(state, failures, recommended, candidates);
  if (bindingConstraint && !derivedFailureModes.includes(bindingConstraint)) {
    derivedFailureModes.push(bindingConstraint);
  }

  const failureModes = [...failures];
  for (const mode of derivedFailureModes) {
    if (!failureModes.includes(mode)) {
      failureModes.push(mode);
    }
  }

  const sorted = [...candidates].sort((a, b) => {
    if (a.pathId === "wait-for-reset") {
      return 1;
    }
    if (b.pathId === "wait-for-reset") {
      return -1;
    }
    if (a.fitsIncludedUsage !== b.fitsIncludedUsage) {
      return a.fitsIncludedUsage ? -1 : 1;
    }
    if (a.fitsSpendPolicy !== b.fitsSpendPolicy) {
      return a.fitsSpendPolicy ? -1 : 1;
    }
    return b.capabilityTier - a.capabilityTier;
  });

  return {
    observedState: state,
    workloadInference: {
      workload: "normal",
      confidence: state.confidence,
      reasons: ["Derived from current burn and reset horizon"],
    },
    failureModes,
    bindingConstraint,
    viablePaths: sorted,
    recommendedPath: recommended,
    overageAlternatives: sorted.filter((path) => path.projectedWindowOverageUsd > 0),
    resets: {
      sessionMinutes: state.resetsInMinutes,
      weeklySonnetHours: state.weeklySonnetResetsInHours,
    },
    confidence: state.confidence,
    explanation: recommended ? recommended.reason : ["No viable path"],
  };
}
