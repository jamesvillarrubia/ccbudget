# ccbudget Decision Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `ccbudget` into a CLI-first decision engine that classifies multi-model failure modes, recommends capability-preserving paths before cost-cutting, supports conservative-overage policy thresholds, and ships as a standalone binary with optional Claude wrappers.

**Architecture:** Introduce a new `src/decision-engine/` boundary that normalizes raw telemetry, infers workload, classifies failure modes, ranks candidate paths, and returns a structured `DecisionResult`. Keep the existing CLI usable during the transition by adapting the new engine back into the current `Recommendation` shape before replacing presentation. Package the final CLI as both an npm binary and GitHub Release standalone executables.

**Tech Stack:** TypeScript, Vitest, tsup, Node.js SEA packaging, GitHub Actions

---

## File Structure

**Create:**
- `src/config.ts`
- `src/decision-engine/types.ts`
- `src/decision-engine/normalize-state.ts`
- `src/decision-engine/workload-inference.ts`
- `src/decision-engine/classify-failures.ts`
- `src/decision-engine/evaluate-paths.ts`
- `src/decision-engine/index.ts`
- `src/decision-engine/legacy-adapter.ts`
- `src/presentation.ts`
- `scripts/build-sea.mjs`
- `sea-config.json`
- `README.md`
- `integrations/claude/commands/budget.md`
- `test/config.test.ts`
- `test/decision-engine/normalize-state.test.ts`
- `test/decision-engine/workload-inference.test.ts`
- `test/decision-engine/evaluate-paths.test.ts`
- `test/decision-engine/index.test.ts`
- `test/presentation.test.ts`
- `.github/workflows/release.yml`

**Modify:**
- `package.json`
- `src/types.ts`
- `src/pricing.ts`
- `src/estimator.ts`
- `src/cli.ts`

**Existing files to preserve during migration:**
- `src/collectors.ts`
- `src/state.ts`
- `src/storage.ts`
- `src/shell.ts`

---

### Task 1: Add policy/config primitives and decision-engine types

**Files:**
- Create: `src/config.ts`
- Create: `src/decision-engine/types.ts`
- Test: `test/config.test.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Write the failing config tests**

```ts
import { describe, expect, it } from "vitest";
import { readSpendPolicyFromEnv } from "../src/config.js";

describe("readSpendPolicyFromEnv", () => {
  it("defaults to conservative no-extra-spend policy", () => {
    const policy = readSpendPolicyFromEnv({});

    expect(policy.allowOverage).toBe(false);
    expect(policy.maxHourlyOverageUsd).toBe(0);
    expect(policy.maxWindowOverageUsd).toBe(0);
    expect(policy.preserveCapabilityAbove.opusToSonnetUsdPerHour).toBe(0);
    expect(policy.preserveCapabilityAbove.sonnetToHaikuUsdPerHour).toBe(0);
  });

  it("parses explicit thresholds from env", () => {
    const policy = readSpendPolicyFromEnv({
      CCBUDGET_ALLOW_OVERAGE: "1",
      CCBUDGET_MAX_HOURLY_OVERAGE_USD: "4.5",
      CCBUDGET_MAX_WINDOW_OVERAGE_USD: "11",
      CCBUDGET_OPUS_TO_SONNET_USD_PER_HOUR: "3",
      CCBUDGET_SONNET_TO_HAIKU_USD_PER_HOUR: "1.25",
    });

    expect(policy.allowOverage).toBe(true);
    expect(policy.maxHourlyOverageUsd).toBe(4.5);
    expect(policy.maxWindowOverageUsd).toBe(11);
    expect(policy.preserveCapabilityAbove.opusToSonnetUsdPerHour).toBe(3);
    expect(policy.preserveCapabilityAbove.sonnetToHaikuUsdPerHour).toBe(1.25);
  });
});
```

- [ ] **Step 2: Run the config test to verify it fails**

Run: `pnpm vitest run test/config.test.ts`

Expected: FAIL with module-not-found errors for `src/config.ts`.

- [ ] **Step 3: Implement spend policy config parsing**

```ts
// src/config.ts
import type { SpendPolicy } from "./decision-engine/types.js";

function num(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function readSpendPolicyFromEnv(
  env: Record<string, string | undefined> = process.env,
): SpendPolicy {
  return {
    allowOverage: bool(env.CCBUDGET_ALLOW_OVERAGE),
    maxHourlyOverageUsd: num(env.CCBUDGET_MAX_HOURLY_OVERAGE_USD),
    maxWindowOverageUsd: num(env.CCBUDGET_MAX_WINDOW_OVERAGE_USD),
    preserveCapabilityAbove: {
      opusToSonnetUsdPerHour: num(env.CCBUDGET_OPUS_TO_SONNET_USD_PER_HOUR),
      sonnetToHaikuUsdPerHour: num(env.CCBUDGET_SONNET_TO_HAIKU_USD_PER_HOUR),
    },
  };
}
```

- [ ] **Step 4: Add the new decision-engine types**

```ts
// src/decision-engine/types.ts
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

export interface DecisionResult {
  observedState: ObservedState;
  workloadInference: WorkloadInference;
  failureModes: FailureMode[];
  bindingConstraint: string | null;
  viablePaths: CandidatePath[];
  recommendedPath: CandidatePath | null;
  overageAlternatives: CandidatePath[];
  resets: {
    sessionMinutes: number | null;
    weeklySonnetHours: number | null;
  };
  confidence: number;
  explanation: string[];
}
```

- [ ] **Step 5: Extend `src/types.ts` to import/export the new public types**

```ts
// near the bottom of src/types.ts
export type {
  CandidatePath,
  DecisionResult,
  FailureMode,
  ModelId,
  ObservedState,
  SpendPolicy,
  WorkloadInference,
} from "./decision-engine/types.js";
```

- [ ] **Step 6: Run tests and typecheck**

Run:
- `pnpm vitest run test/config.test.ts`
- `pnpm typecheck`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/decision-engine/types.ts src/types.ts test/config.test.ts
git commit -m "feat: add decision engine policy types"
```

---

### Task 2: Normalize telemetry into a stable observed state and infer workload

**Files:**
- Create: `src/decision-engine/normalize-state.ts`
- Create: `src/decision-engine/workload-inference.ts`
- Test: `test/decision-engine/normalize-state.test.ts`
- Test: `test/decision-engine/workload-inference.test.ts`

- [ ] **Step 1: Write the failing normalization tests**

```ts
import { describe, expect, it } from "vitest";
import { normalizeObservedState } from "../../src/decision-engine/normalize-state.js";

describe("normalizeObservedState", () => {
  it("maps the latest snapshots into a stable observed state", () => {
    const state = normalizeObservedState(
      [
        {
          ts: "2026-04-12T20:00:00.000Z",
          source: "manual",
          token: { model: "claude-opus-4-1", tokensIn: 1000, tokensOut: 300, tokensCached: 500, workloadClass: "tool-heavy" },
          usage: { sessionPct: 64, sessionResetsInMinutes: 90, weeklySonnetPct: 12, weeklySonnetResetsInHours: 88 },
          accounting: { totalTokensCumulative: 250000, opusTokensCumulative: 190000, sonnetTokensCumulative: 60000 },
        },
      ],
      {
        allowOverage: false,
        maxHourlyOverageUsd: 0,
        maxWindowOverageUsd: 0,
        preserveCapabilityAbove: { opusToSonnetUsdPerHour: 0, sonnetToHaikuUsdPerHour: 0 },
      },
    );

    expect(state.currentModel).toBe("opus");
    expect(state.currentSessionPct).toBe(64);
    expect(state.resetsInMinutes).toBe(90);
    expect(state.weeklySonnetPct).toBe(12);
  });
});
```

- [ ] **Step 2: Write the failing workload inference tests**

```ts
import { describe, expect, it } from "vitest";
import { inferWorkload } from "../../src/decision-engine/workload-inference.js";

describe("inferWorkload", () => {
  it("classifies heavy workload from sustained high burn", () => {
    const result = inferWorkload({
      currentBurnPctPerHour: 28,
      currentSessionPct: 70,
      resetsInMinutes: 110,
      recentOpusFraction: 0.9,
      burnVolatility: 0.08,
    });

    expect(result.workload).toBe("heavy");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("classifies spiky workload from volatile burn", () => {
    const result = inferWorkload({
      currentBurnPctPerHour: 10,
      currentSessionPct: 26,
      resetsInMinutes: 250,
      recentOpusFraction: 0.4,
      burnVolatility: 0.65,
    });

    expect(result.workload).toBe("spiky");
  });
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run:
- `pnpm vitest run test/decision-engine/normalize-state.test.ts`
- `pnpm vitest run test/decision-engine/workload-inference.test.ts`

Expected: FAIL with missing module errors.

- [ ] **Step 4: Implement observed-state normalization**

```ts
// src/decision-engine/normalize-state.ts
import { isPeakHour } from "../pricing.js";
import { estimateModelMix } from "../estimator.js";
import type { SnapshotEvent } from "../types.js";
import type { ModelId, ObservedState, SpendPolicy } from "./types.js";

function inferCurrentModel(modelName: string | undefined): ModelId | null {
  const lower = String(modelName ?? "").toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  return null;
}

export function normalizeObservedState(
  snapshots: SnapshotEvent[],
  policy: SpendPolicy,
): ObservedState {
  const latest = snapshots.at(-1);
  const mix = estimateModelMix(snapshots);

  return {
    currentModel: inferCurrentModel(latest?.token?.model),
    currentSessionPct: latest?.usage?.sessionPct ?? null,
    currentBurnPctPerHour: latest?.ccburnSignal?.percentPerHour ?? null,
    resetsInMinutes: latest?.usage?.sessionResetsInMinutes ?? latest?.ccburnSignal?.sessionResetsInMinutes ?? null,
    weeklySonnetPct: latest?.usage?.weeklySonnetPct ?? null,
    weeklySonnetResetsInHours: latest?.usage?.weeklySonnetResetsInHours ?? null,
    isPeak: isPeakHour(new Date(latest?.ts ?? Date.now())),
    confidence: latest?.ccburnSignal ? 0.7 : mix.opusFraction > 0 || mix.sonnetFraction > 0 ? 0.5 : 0.25,
    policy,
  };
}
```

- [ ] **Step 5: Implement workload inference**

```ts
// src/decision-engine/workload-inference.ts
import type { WorkloadInference } from "./types.js";

interface WorkloadInput {
  currentBurnPctPerHour: number | null;
  currentSessionPct: number | null;
  resetsInMinutes: number | null;
  recentOpusFraction: number;
  burnVolatility: number;
}

export function inferWorkload(input: WorkloadInput): WorkloadInference {
  const reasons: string[] = [];
  const burn = input.currentBurnPctPerHour ?? 0;

  if (input.burnVolatility >= 0.5) {
    reasons.push("Burn is highly volatile");
    return { workload: "spiky", confidence: 0.7, reasons };
  }
  if (burn >= 20 || input.recentOpusFraction >= 0.8) {
    reasons.push("Sustained high burn or strong Opus preference");
    return { workload: "heavy", confidence: 0.75, reasons };
  }
  if (burn >= 8) {
    reasons.push("Moderate sustained burn");
    return { workload: "normal", confidence: 0.65, reasons };
  }
  reasons.push("Low sustained burn");
  return { workload: "light", confidence: 0.6, reasons };
}
```

- [ ] **Step 6: Run tests and typecheck**

Run:
- `pnpm vitest run test/decision-engine/normalize-state.test.ts test/decision-engine/workload-inference.test.ts`
- `pnpm typecheck`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/decision-engine/normalize-state.ts src/decision-engine/workload-inference.ts test/decision-engine/normalize-state.test.ts test/decision-engine/workload-inference.test.ts
git commit -m "feat: add workload inference and observed state normalization"
```

---

### Task 3: Add overage math, failure classification, and candidate-path evaluation

**Files:**
- Modify: `src/pricing.ts`
- Create: `src/decision-engine/classify-failures.ts`
- Create: `src/decision-engine/evaluate-paths.ts`
- Test: `test/decision-engine/evaluate-paths.test.ts`

- [ ] **Step 1: Write failing decision tests**

```ts
import { describe, expect, it } from "vitest";
import { evaluateCandidatePaths } from "../../src/decision-engine/evaluate-paths.js";

describe("evaluateCandidatePaths", () => {
  it("prefers acceptable Sonnet overage over a Haiku downgrade", () => {
    const result = evaluateCandidatePaths({
      currentModel: "sonnet",
      currentSessionPct: 92,
      currentBurnPctPerHour: 18,
      resetsInMinutes: 120,
      weeklySonnetPct: 88,
      weeklySonnetResetsInHours: 30,
      isPeak: false,
      confidence: 0.8,
      policy: {
        allowOverage: true,
        maxHourlyOverageUsd: 4,
        maxWindowOverageUsd: 6,
        preserveCapabilityAbove: {
          opusToSonnetUsdPerHour: 3,
          sonnetToHaikuUsdPerHour: 2,
        },
      },
    });

    expect(result.recommendedPath?.pathId).toBe("continue-on-sonnet-with-overage");
  });

  it("falls back to wait-for-reset when no included or paid path fits policy", () => {
    const result = evaluateCandidatePaths({
      currentModel: "opus",
      currentSessionPct: 98,
      currentBurnPctPerHour: 25,
      resetsInMinutes: 40,
      weeklySonnetPct: 95,
      weeklySonnetResetsInHours: 36,
      isPeak: true,
      confidence: 0.8,
      policy: {
        allowOverage: false,
        maxHourlyOverageUsd: 0,
        maxWindowOverageUsd: 0,
        preserveCapabilityAbove: {
          opusToSonnetUsdPerHour: 0,
          sonnetToHaikuUsdPerHour: 0,
        },
      },
    });

    expect(result.recommendedPath?.pathId).toBe("wait-for-reset");
    expect(result.failureModes).toContain("wait-for-reset-better-than-continuing");
  });
});
```

- [ ] **Step 2: Run the decision test to verify it fails**

Run: `pnpm vitest run test/decision-engine/evaluate-paths.test.ts`

Expected: FAIL with missing module errors.

- [ ] **Step 3: Extend pricing with Haiku and overage estimation helpers**

```ts
// src/pricing.ts
export const DEFAULT_PRICES_PER_1M = {
  opus: { input: 15, output: 75, cachedInput: 1.5 },
  sonnet: { input: 3, output: 15, cachedInput: 0.3 },
  haiku: { input: 0.8, output: 4, cachedInput: 0.08 },
} as const;

export function estimateOverageUsd(
  model: "opus" | "sonnet" | "haiku",
  tokensPerHour: number,
): number {
  const price = DEFAULT_PRICES_PER_1M[model];
  const weightedPer1M = price.input * 0.6 + price.output * 0.3 + (price.cachedInput ?? price.input) * 0.1;
  return (tokensPerHour / 1_000_000) * weightedPer1M;
}
```

- [ ] **Step 4: Implement failure-mode classification**

```ts
// src/decision-engine/classify-failures.ts
import type { FailureMode, ObservedState } from "./types.js";

export function classifyFailureModes(state: ObservedState): FailureMode[] {
  const modes: FailureMode[] = [];

  if ((state.currentSessionPct ?? 0) >= 90) {
    modes.push("current-model-window-exhaustion");
  }
  if ((state.weeklySonnetPct ?? 0) >= 85) {
    modes.push("fallback-model-cap-exhaustion");
  }
  if ((state.currentSessionPct ?? 0) >= 98 && (state.weeklySonnetPct ?? 0) >= 95) {
    modes.push("global-included-budget-exhaustion");
  }
  if (state.isPeak) {
    modes.push("peak-hour-distortion");
  }
  if (state.confidence < 0.5) {
    modes.push("forecast-uncertain");
  }

  return modes;
}
```

- [ ] **Step 5: Implement candidate-path evaluation**

```ts
// src/decision-engine/evaluate-paths.ts
import { estimateOverageUsd } from "../pricing.js";
import type { CandidatePath, DecisionResult, ModelId, ObservedState } from "./types.js";
import { classifyFailureModes } from "./classify-failures.js";

function capabilityTier(model: ModelId | null): 3 | 2 | 1 | 0 {
  if (model === "opus") return 3;
  if (model === "sonnet") return 2;
  if (model === "haiku") return 1;
  return 0;
}

function projectedRunwayMinutes(state: ObservedState, multiplier: number): number | null {
  if (state.currentBurnPctPerHour == null || state.currentBurnPctPerHour <= 0 || state.currentSessionPct == null) {
    return null;
  }
  const remainingPct = Math.max(0, 100 - state.currentSessionPct);
  return Math.round((remainingPct / (state.currentBurnPctPerHour * multiplier)) * 60);
}

function buildPath(
  pathId: string,
  model: ModelId | null,
  multiplier: number,
  state: ObservedState,
): CandidatePath {
  const runway = projectedRunwayMinutes(state, multiplier);
  const tokensPerHour = (state.currentBurnPctPerHour ?? 0) * 40_000;
  const overagePerHour = model ? estimateOverageUsd(model, tokensPerHour) : 0;
  const resets = state.resetsInMinutes ?? 0;
  const overageForWindow = overagePerHour * (resets / 60);
  const fitsIncludedUsage = runway == null ? true : runway >= resets;
  const fitsSpendPolicy =
    fitsIncludedUsage ||
    (state.policy.allowOverage &&
      overagePerHour <= state.policy.maxHourlyOverageUsd &&
      overageForWindow <= state.policy.maxWindowOverageUsd);

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

export function evaluateCandidatePaths(state: ObservedState): DecisionResult {
  const failures = classifyFailureModes(state);
  const candidates = [
    buildPath("stay-on-opus", "opus", 1, state),
    buildPath("switch-to-sonnet", "sonnet", 0.3, state),
    buildPath("switch-to-haiku", "haiku", 0.15, state),
    { ...buildPath("continue-on-sonnet-with-overage", "sonnet", 0.3, state), fitsIncludedUsage: false },
    { ...buildPath("wait-for-reset", null, 0, state), fitsIncludedUsage: true, fitsSpendPolicy: true, projectedRunwayMinutes: state.resetsInMinutes ?? null },
  ];

  const sorted = candidates.sort((a, b) => {
    if (a.fitsIncludedUsage !== b.fitsIncludedUsage) return a.fitsIncludedUsage ? -1 : 1;
    if (a.fitsSpendPolicy !== b.fitsSpendPolicy) return a.fitsSpendPolicy ? -1 : 1;
    return b.capabilityTier - a.capabilityTier;
  });

  let recommended = sorted.find((path) => path.fitsIncludedUsage) ?? sorted.find((path) => path.fitsSpendPolicy) ?? null;

  if (!recommended || (!recommended.fitsIncludedUsage && !recommended.fitsSpendPolicy)) {
    recommended = sorted.find((path) => path.pathId === "wait-for-reset") ?? null;
  }

  if (recommended) {
    recommended.accepted = true;
    recommended.reason.push("Best remaining path after included-usage and spend-policy checks");
  }

  return {
    observedState: state,
    workloadInference: { workload: "normal", confidence: state.confidence, reasons: ["Derived from current burn and reset horizon"] },
    failureModes: recommended?.pathId === "wait-for-reset"
      ? [...failures, "wait-for-reset-better-than-continuing"]
      : recommended?.pathId === "continue-on-sonnet-with-overage"
        ? [...failures, "acceptable-overage-preserves-capability"]
        : failures,
    bindingConstraint: failures[0] ?? null,
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
```

- [ ] **Step 6: Run tests and typecheck**

Run:
- `pnpm vitest run test/decision-engine/evaluate-paths.test.ts`
- `pnpm typecheck`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/pricing.ts src/decision-engine/classify-failures.ts src/decision-engine/evaluate-paths.ts test/decision-engine/evaluate-paths.test.ts
git commit -m "feat: evaluate multi-model budget paths"
```

---

### Task 4: Compose the full decision engine and adapt it to the legacy estimator

**Files:**
- Create: `src/decision-engine/index.ts`
- Create: `src/decision-engine/legacy-adapter.ts`
- Modify: `src/estimator.ts`
- Test: `test/decision-engine/index.test.ts`

- [ ] **Step 1: Write the failing end-to-end decision-engine test**

```ts
import { describe, expect, it } from "vitest";
import { buildDecisionResult } from "../../src/decision-engine/index.js";

describe("buildDecisionResult", () => {
  it("returns a structured recommendation with viable paths and a binding constraint", () => {
    const result = buildDecisionResult(
      [
        {
          ts: "2026-04-12T20:00:00.000Z",
          source: "manual",
          token: { model: "claude-sonnet-4-5", tokensIn: 1000, tokensOut: 300, tokensCached: 0, workloadClass: "tool-heavy" },
          usage: { sessionPct: 93, sessionResetsInMinutes: 120, weeklySonnetPct: 82, weeklySonnetResetsInHours: 28 },
          ccburnSignal: { percentPerHour: 18, trend: "up", estimatedMinutesTo100: 24, recommendation: "switch", sessionResetsInMinutes: 120, projectedEndPct: 100, hitsLimit: true },
        },
      ],
      {
        allowOverage: false,
        maxHourlyOverageUsd: 0,
        maxWindowOverageUsd: 0,
        preserveCapabilityAbove: { opusToSonnetUsdPerHour: 0, sonnetToHaikuUsdPerHour: 0 },
      },
    );

    expect(result.failureModes.length).toBeGreaterThan(0);
    expect(result.viablePaths.length).toBeGreaterThan(1);
    expect(result.bindingConstraint).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the end-to-end decision test to verify it fails**

Run: `pnpm vitest run test/decision-engine/index.test.ts`

Expected: FAIL with missing module errors.

- [ ] **Step 3: Implement the composition entry point**

```ts
// src/decision-engine/index.ts
import type { SnapshotEvent } from "../types.js";
import type { DecisionResult, SpendPolicy } from "./types.js";
import { normalizeObservedState } from "./normalize-state.js";
import { inferWorkload } from "./workload-inference.js";
import { evaluateCandidatePaths } from "./evaluate-paths.js";

export function buildDecisionResult(
  snapshots: SnapshotEvent[],
  policy: SpendPolicy,
): DecisionResult {
  const observedState = normalizeObservedState(snapshots, policy);
  const result = evaluateCandidatePaths(observedState);
  const workload = inferWorkload({
    currentBurnPctPerHour: observedState.currentBurnPctPerHour,
    currentSessionPct: observedState.currentSessionPct,
    resetsInMinutes: observedState.resetsInMinutes,
    recentOpusFraction: observedState.currentModel === "opus" ? 1 : 0,
    burnVolatility: observedState.confidence < 0.5 ? 0.6 : 0.1,
  });

  return {
    ...result,
    workloadInference: workload,
    confidence: Math.min(0.95, (result.confidence + workload.confidence) / 2),
  };
}
```

- [ ] **Step 4: Implement the legacy adapter**

```ts
// src/decision-engine/legacy-adapter.ts
import type { Recommendation } from "../types.js";
import type { DecisionResult } from "./types.js";

export function toLegacyRecommendation(result: DecisionResult): Recommendation {
  const path = result.recommendedPath;
  const model = path?.model === "haiku" ? "either" : path?.model ?? "either";

  return {
    recommendedModel: model,
    confidence: result.confidence,
    reason: result.explanation,
    sessionPct: result.observedState.currentSessionPct ?? undefined,
    sessionBurnPctPerHour: result.observedState.currentBurnPctPerHour ?? undefined,
    windowResetsInMinutes: result.resets.sessionMinutes ?? undefined,
    weeklySonnetPct: result.observedState.weeklySonnetPct ?? undefined,
    weeklySonnetResetsInHours: result.resets.weeklySonnetHours ?? undefined,
    sonnetCapAvailable: (result.observedState.weeklySonnetPct ?? 0) < 85,
    willHitLimit: result.failureModes.includes("current-model-window-exhaustion"),
    dataSource: "ccburn",
  };
}
```

- [ ] **Step 5: Refactor `src/estimator.ts` to delegate to the decision engine**

```ts
// near the top of src/estimator.ts
import { readSpendPolicyFromEnv } from "./config.js";
import { buildDecisionResult } from "./decision-engine/index.js";
import { toLegacyRecommendation } from "./decision-engine/legacy-adapter.js";

// replace buildRecommendation implementation body
export function buildRecommendation(snapshots: SnapshotEvent[], _windowMinutes = 300, _baseline?: PricingBaseline | null): Recommendation {
  const policy = readSpendPolicyFromEnv();
  const result = buildDecisionResult(snapshots, policy);
  return toLegacyRecommendation(result);
}
```

- [ ] **Step 6: Run tests and typecheck**

Run:
- `pnpm vitest run test/decision-engine/index.test.ts`
- `pnpm test`
- `pnpm typecheck`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/decision-engine/index.ts src/decision-engine/legacy-adapter.ts src/estimator.ts test/decision-engine/index.test.ts
git commit -m "feat: wire decision engine into legacy estimator"
```

---

### Task 5: Replace the advisor presentation and expose the structured result

**Files:**
- Create: `src/presentation.ts`
- Modify: `src/cli.ts`
- Test: `test/presentation.test.ts`

- [ ] **Step 1: Write failing presentation tests**

```ts
import { describe, expect, it } from "vitest";
import { formatDecisionSummary } from "../src/presentation.js";

describe("formatDecisionSummary", () => {
  it("renders the failure mode, binding constraint, and recommended path", () => {
    const output = formatDecisionSummary({
      observedState: {
        currentModel: "sonnet",
        currentSessionPct: 93,
        currentBurnPctPerHour: 18,
        resetsInMinutes: 90,
        weeklySonnetPct: 88,
        weeklySonnetResetsInHours: 24,
        isPeak: false,
        confidence: 0.8,
        policy: {
          allowOverage: false,
          maxHourlyOverageUsd: 0,
          maxWindowOverageUsd: 0,
          preserveCapabilityAbove: { opusToSonnetUsdPerHour: 0, sonnetToHaikuUsdPerHour: 0 },
        },
      },
      workloadInference: { workload: "heavy", confidence: 0.7, reasons: ["high sustained burn"] },
      failureModes: ["current-model-window-exhaustion"],
      bindingConstraint: "5h session window",
      viablePaths: [],
      recommendedPath: {
        pathId: "switch-to-sonnet",
        model: "sonnet",
        capabilityTier: 2,
        fitsIncludedUsage: true,
        fitsSpendPolicy: true,
        projectedRunwayMinutes: 120,
        projectedWindowOverageUsd: 0,
        projectedHourlyOverageUsd: 0,
        accepted: true,
        reason: ["Included usage survives the window"],
      },
      overageAlternatives: [],
      resets: { sessionMinutes: 90, weeklySonnetHours: 24 },
      confidence: 0.75,
      explanation: ["Included usage survives the window"],
    });

    expect(output).toContain("Failure mode");
    expect(output).toContain("Recommended path");
    expect(output).toContain("switch-to-sonnet");
  });
});
```

- [ ] **Step 2: Run the presentation test to verify it fails**

Run: `pnpm vitest run test/presentation.test.ts`

Expected: FAIL with missing module errors.

- [ ] **Step 3: Implement the human formatter**

```ts
// src/presentation.ts
import type { DecisionResult } from "./decision-engine/types.js";

export function formatDecisionSummary(result: DecisionResult): string {
  const lines = [
    "Claude Budget Decision",
    `Failure mode: ${result.failureModes.join(", ") || "none"}`,
    `Binding constraint: ${result.bindingConstraint ?? "none"}`,
    `Expected workload: ${result.workloadInference.workload}`,
    `Recommended path: ${result.recommendedPath?.pathId ?? "none"}`,
    `Confidence: ${Math.round(result.confidence * 100)}%`,
  ];

  if (result.recommendedPath?.projectedWindowOverageUsd) {
    lines.push(`Projected overage: $${result.recommendedPath.projectedWindowOverageUsd.toFixed(2)} this window`);
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Update `src/cli.ts` to expose structured JSON and new text output**

```ts
// add near imports
import { readSpendPolicyFromEnv } from "./config.js";
import { buildDecisionResult } from "./decision-engine/index.js";
import { formatDecisionSummary } from "./presentation.js";

// inside runAdvisorNow, after snapshots are loaded
const policy = readSpendPolicyFromEnv();
const decision = buildDecisionResult(snapshots, policy);

if (args.flags.has("json")) {
  process.stdout.write(`${JSON.stringify({ ok: true, windowMinutes, decision }, null, 2)}\n`);
  return;
}

process.stdout.write(formatDecisionSummary(decision) + "\n");
```

- [ ] **Step 5: Run tests and typecheck**

Run:
- `pnpm vitest run test/presentation.test.ts`
- `pnpm test`
- `pnpm typecheck`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/presentation.ts src/cli.ts test/presentation.test.ts
git commit -m "feat: expose structured decision output"
```

---

### Task 6: Package as a standalone binary and add GitHub release automation

**Files:**
- Create: `scripts/build-sea.mjs`
- Create: `sea-config.json`
- Create: `.github/workflows/release.yml`
- Create: `README.md`
- Create: `integrations/claude/commands/budget.md`
- Modify: `package.json`

- [ ] **Step 1: Update package metadata and scripts**

```json
{
  "name": "cc-rate-estimator",
  "version": "0.1.0",
  "private": false,
  "bin": {
    "ccbudget": "dist/cli.js"
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build:sea": "node scripts/build-sea.mjs",
    "release:smoke": "node dist/cli.js advisor now --json"
  }
}
```

- [ ] **Step 2: Add the SEA config**

```json
{
  "main": "dist/cli.js",
  "output": ".sea/ccbudget.blob",
  "disableExperimentalSEAWarning": true
}
```

- [ ] **Step 3: Implement the Node SEA build script**

```js
// scripts/build-sea.mjs
import { cp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const outDir = join(process.cwd(), "release");
const seaDir = join(process.cwd(), ".sea");

await rm(outDir, { recursive: true, force: true });
await rm(seaDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await exec(process.execPath, ["--experimental-sea-config", "sea-config.json"]);

const target = join(outDir, process.platform === "win32" ? "ccbudget.exe" : "ccbudget");
await cp(process.execPath, target);

if (process.platform === "darwin") {
  await exec("codesign", ["--remove-signature", target]).catch(() => {});
}

await exec("pnpm", [
  "exec",
  "postject",
  target,
  "NODE_SEA_BLOB",
  join(seaDir, "ccbudget.blob"),
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
]);
```

- [ ] **Step 4: Add release workflow**

```yaml
name: release

on:
  push:
    tags:
      - "v*"

jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm add -D postject
      - run: pnpm build:sea
      - uses: softprops/action-gh-release@v2
        with:
          files: release/*
```

- [ ] **Step 5: Add user-facing installation docs and Claude wrapper template**

```md
<!-- README.md -->
# ccbudget

CLI-first Claude budget decision engine.

## Install

- npm/pnpm users: install the package and run `ccbudget`
- binary users: download the platform-specific asset from GitHub Releases

## Claude wrapper

See `integrations/claude/commands/budget.md` for a personal `/budget` command.
```

```md
<!-- integrations/claude/commands/budget.md -->
---
description: Show current Claude budget decision summary
allowed-tools: Bash(ccbudget:*)
disable-model-invocation: true
---

Run:

!`ccbudget advisor now`

Summarize:
- failure mode
- recommended path
- any overage warning
```

- [ ] **Step 6: Run build and smoke verification**

Run:
- `pnpm build`
- `pnpm build:sea`
- `node dist/cli.js advisor now --json`

Expected:
- `dist/cli.js` builds
- `release/ccbudget` or `release/ccbudget.exe` exists
- advisor returns valid JSON

- [ ] **Step 7: Commit**

```bash
git add package.json sea-config.json scripts/build-sea.mjs .github/workflows/release.yml README.md integrations/claude/commands/budget.md
git commit -m "feat: package ccbudget for binary releases"
```

---

## Self-Review

### Spec coverage

- Hybrid decision tree: covered by Tasks 2-4
- Multi-model failure modes: covered by Tasks 3-4
- Conservative spend policy with thresholds: covered by Tasks 1 and 3
- Structured result schema: covered by Tasks 1 and 5
- CLI-first packaging and binaries: covered by Task 6
- Optional Claude wrapper: covered by Task 6

### Placeholder scan

- No `TBD`/`TODO` placeholders remain
- Each task names exact files
- Each task contains explicit commands
- Each code-writing step contains concrete code

### Type consistency

- `SpendPolicy` is defined once in `src/decision-engine/types.ts`
- `DecisionResult` flows from engine to presentation
- `Recommendation` remains the compatibility shape via `legacy-adapter.ts`

### Scope check

- This plan stays within one subsystem: `ccbudget` decision engine + packaging
- No unrelated dashboard or cloud features were added

---

Plan complete and saved to `docs/superpowers/plans/2026-04-12-ccbudget-decision-engine.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
