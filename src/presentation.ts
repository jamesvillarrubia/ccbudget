import type { DecisionResult, Recommendation } from "./types.js";

export interface AdvisorJsonPayload {
  ok: true;
  windowMinutes: number;
  decision: DecisionResult;
  recommendation: Recommendation;
}

/**
 * Human-readable summary of a decision-engine result for terminal / hooks.
 */
export function formatDecisionSummary(result: DecisionResult): string {
  const failureLabel = result.failureModes.length === 1 ? "Failure mode" : "Failure modes";
  const failureValue = result.failureModes.length > 0 ? result.failureModes.join(", ") : "none";

  const lines = [
    "Claude Budget Decision",
    `${failureLabel}: ${failureValue}`,
    `Binding constraint: ${result.bindingConstraint ?? "none"}`,
    `Expected workload: ${result.workloadInference.workload} (${Math.round(result.workloadInference.confidence * 100)}% conf.)`,
  ];

  const path = result.recommendedPath;
  lines.push(
    `Recommended path: ${
      path ? `${path.pathId} (model: ${path.model ?? "n/a"}, tier ${path.capabilityTier})` : "none"
    }`,
  );
  lines.push(`Confidence: ${Math.round(result.confidence * 100)}%`);

  if (path && path.projectedWindowOverageUsd > 0) {
    lines.push(`Projected overage: $${path.projectedWindowOverageUsd.toFixed(2)} this window`);
  }

  if (result.explanation.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const line of result.explanation) {
      lines.push(`  - ${line}`);
    }
  }

  return lines.join("\n");
}

/**
 * Keep both payloads in `advisor now --json` intentionally:
 * `decision` is the new structured contract, while `recommendation`
 * preserves the legacy shape for existing callers during the transition.
 */
export function buildAdvisorJsonPayload(input: {
  windowMinutes: number;
  decision: DecisionResult;
  recommendation: Recommendation;
}): AdvisorJsonPayload {
  return {
    ok: true,
    windowMinutes: input.windowMinutes,
    decision: input.decision,
    recommendation: input.recommendation,
  };
}
