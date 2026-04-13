# ccbudget Decision Engine Design

## Goal

Upgrade `ccbudget` from a narrow current-window advisor into a portable decision engine that:

- reasons about multiple models and multiple constraints at once,
- maximizes capability first,
- minimizes spend only after capability-preserving options fail or exceed configured spend thresholds,
- ships as a standalone binary with optional Claude-specific wrappers.

## Product Boundary

The product is **CLI-first**.

`ccbudget` remains the core artifact and source of truth. Claude slash commands, hooks, and statusline integrations are wrappers over the CLI, not the primary product surface.

This boundary is intentional:

- the decision engine stays portable and testable outside Claude,
- distribution via GitHub Releases becomes practical,
- model/budget policy is not coupled to one editor or one plugin format,
- Claude integration can evolve without destabilizing the core engine.

## Primary Decision Policy

The engine uses a **hybrid** strategy:

1. **Hard decision tree for failure-mode classification**
2. **Scoring/ranking inside each branch for viable alternatives**

This is the correct compromise between two bad extremes:

- a pure decision tree becomes brittle and repetitive as models and constraints grow,
- a pure scoring system becomes hard to explain and easy to mistrust.

The policy priority is:

1. **Preserve the highest useful capability within included limits**
2. **Preserve capability with acceptable paid overage**
3. **Downgrade capability**
4. **Wait or stop**

Spend is not the first-order objective. It becomes primary only after the preferred capability path would violate a hard limit or the user's spend policy.

## Decision Tree

The top-level decision tree should evaluate in this order:

1. **Infer expected workload**
   Use recent burn rate, rolling averages, model mix, time-to-limit, and volatility.
2. **Check whether the current model can satisfy that workload inside active limits**
   If yes, stay on the current model.
3. **Check for a higher-capability or equal-capability alternative that still fits**
   Among viable paths, prefer capability first.
4. **Check whether acceptable overage preserves capability better than downgrade**
   Example: modest Sonnet overage may be better than dropping to Haiku.
5. **Check downgrade paths**
   Use only when capability-preserving paths are unavailable or outside user policy.
6. **Check whether waiting is better than continuing**
   Use reset timing, projected burn, and pricing conditions.
7. **If the user continues anyway, estimate overage**
   This is advisory, not the primary branch.

The engine should never jump directly from "budget is tight" to "use the cheapest model." It must explicitly prove why the current model, higher-capability alternatives, and acceptable overage paths were rejected.

## Workload Inference

Workload is inferred by default from observed behavior:

- recent session burn rate,
- rolling average burn,
- recent model mix,
- usage volatility,
- proximity to reset,
- sustained vs bursty consumption.

The inference output should map to a small set of workload classes such as:

- `light`
- `normal`
- `heavy`
- `spiky`

The default behavior is inference, but the CLI should support an explicit override for cases where history is misleading:

- `--workload light`
- `--workload normal`
- `--workload heavy`

This avoids a common failure mode where the recent history is light, but the user is about to begin a heavy agent loop.

## Failure Mode Catalog

The engine must classify explicit failure modes rather than emitting a generic "budget low" status.

Minimum v1 failure modes:

- `current-model-window-exhaustion`
- `current-model-cap-exhaustion`
- `fallback-model-cap-exhaustion`
- `global-included-budget-exhaustion`
- `acceptable-overage-preserves-capability`
- `downgrade-required-to-avoid-spend`
- `wait-for-reset-better-than-continuing`
- `no-viable-high-capability-path`
- `forecast-uncertain`
- `peak-hour-distortion`

These modes are intentionally separate. For example:

- "Sonnet exhausted, Opus available" is not the same as
- "window exhaustion on Opus, Sonnet healthy" and neither is the same as
- "all practical models available only via overage."

If the tool collapses these states into one status, recommendations will be misleading.

## Constraints Model

The engine should normalize all raw telemetry into a single constraint state before entering the decision tree.

The normalized state should include:

- current model,
- viable models,
- capability tier per model,
- current session/window usage,
- weekly caps,
- per-model caps where applicable,
- reset times,
- current burn,
- projected burn,
- inferred workload,
- peak/off-peak status,
- pricing inputs,
- spend policy,
- confidence.

This normalized state is required because raw CLI snapshots and usage streams will change over time. The tree should depend on stable normalized concepts, not on ad hoc parsing scattered across recommendation logic.

## Spend Policy

Default spend policy is **conservative**:

- do not recommend additional paid spend by default,
- prefer included usage,
- if included usage cannot preserve capability, downgrade or wait.

Over that baseline, the engine supports explicit spend thresholds:

- `maxHourlyOverageUsd`
- `maxWindowOverageUsd`

It also supports **capability-preservation thresholds** that answer questions like:

- how much extra spend is acceptable to stay on Opus instead of dropping to Sonnet,
- how much extra spend is acceptable to stay on Sonnet instead of dropping to Haiku.

These thresholds should be represented separately because the value tradeoff is different:

- `Opus -> Sonnet` is usually a quality/performance tradeoff,
- `Sonnet -> Haiku` is often a meaningful capability downgrade.

Proposed policy shape:

```ts
interface SpendPolicy {
  allowOverage: boolean;
  maxHourlyOverageUsd: number;
  maxWindowOverageUsd: number;
  preserveCapabilityAbove: {
    opusToSonnetUsdPerHour: number;
    sonnetToHaikuUsdPerHour: number;
  };
}
```

Default values should correspond to "no extra spend." Users opt into paid-continuation strategies by raising thresholds.

## Candidate Path Evaluation

Inside each decision-tree branch, the engine evaluates candidate paths rather than only model labels.

A candidate path should include:

- model,
- capability tier,
- whether it fits inside included usage,
- whether it fits inside spend policy,
- projected runway,
- projected reset interaction,
- projected overage cost,
- why it is accepted or rejected.

Example candidate paths:

- `stay-on-opus`
- `switch-to-sonnet`
- `switch-to-haiku`
- `wait-for-reset`
- `continue-on-sonnet-with-overage`

This candidate-path model is necessary for explainability. Users will ask why the tool recommended Sonnet instead of Opus or why it suggested waiting instead of paying a modest overage. The engine must be able to answer from structured data rather than stringly-typed reasons.

## Output Contract

The engine should return a structured result object that both the CLI and Claude wrappers consume.

Minimum output shape:

```ts
interface DecisionResult {
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
```

This contract is preferable to today's "recommended model + reasons" shape because it can power:

- human CLI output,
- machine-readable JSON,
- Claude `/budget` wrappers,
- future GitHub or dashboard integrations.

## Human-Facing Output

The CLI should present results as a compact decision summary, not just a burn metric.

Recommended human output sections:

- `Failure mode`
- `Binding constraint`
- `Expected workload`
- `Recommended path`
- `Viable alternatives`
- `If you continue anyway`
- `Reset timing`
- `Confidence`

Example phrasing:

- `Failure mode: current-model-window-exhaustion`
- `Binding constraint: 5h session window`
- `Recommended path: switch to Sonnet`
- `Why: Sonnet preserves adequate capability and stays within included usage`
- `If you continue on Opus: estimated window overage $4.80 over the next 2.0h`

The human output should remain concise, but the JSON output must expose the full structured decision.

## Packaging And Distribution

The distribution plan should be:

1. **npm package** for users already in Node-based environments
2. **Standalone binaries** for macOS, Linux, and Windows via GitHub Releases
3. **Optional Claude wrappers** layered on top

The standalone binary should be treated as a first-class artifact, not a nice-to-have. Relying on Node, pnpm, and local shell glue alone makes adoption fragile and undercuts the goal of sharing the tool with others.

The recommended artifact stack is:

- `ccbudget` binary
- optional user config file for thresholds and policy
- optional `~/.claude/commands/budget.md`
- optional hook/statusline integrations

The binary is the product. The rest are adapters.

## Non-Goals For This Design Slice

This design does not require:

- a GUI,
- a web dashboard,
- cloud synchronization,
- a model-quality benchmark framework,
- automatic prompt rewriting or routing into Claude itself.

Those may become useful later, but they are not required to deliver a trustworthy decision engine.

## Risks And Failure Cases

Key risks to design for:

- **Inference lag**: historical burn underpredicts imminent heavy usage.
- **False precision**: the tool pretends projections are exact when the data is thin.
- **Policy confusion**: users cannot tell whether the recommendation is constrained by hard limits or by their own spend thresholds.
- **Fallback dishonesty**: the tool says a weaker model is "fine" when it is only technically available.
- **Pricing drift**: hardcoded prices become stale.
- **Integration coupling**: Claude-specific wrappers leak assumptions into the core decision logic.

Mitigations:

- explicit confidence output,
- optional workload override,
- explicit `bindingConstraint`,
- explicit candidate-path rejection reasons,
- environment/config-driven pricing,
- strict separation between core engine and wrappers.

## Testing Strategy

Testing should focus on deterministic decision behavior, not just arithmetic helpers.

Minimum test layers:

1. **Constraint normalization tests**
   Raw telemetry -> normalized state
2. **Failure-mode classification tests**
   Named inputs -> expected failure modes
3. **Decision-tree tests**
   Expected workload + constraints -> recommended path
4. **Spend-policy tests**
   Conservative default vs threshold-enabled overage behavior
5. **Output-contract tests**
   JSON result stability for wrappers and automation
6. **Packaging smoke tests**
   Standalone binary launches and returns valid output on all target platforms

The highest-value tests are scenario tests that capture real edge cases such as:

- Sonnet exhausted, Opus healthy
- Opus about to hit window, Sonnet healthy
- Sonnet weekly cap nearly exhausted, Haiku available
- Sonnet modest overage cheaper than Haiku downgrade in capability terms
- all included usage exhausted, waiting better than continuing
- uncertain forecast with low confidence

## Implementation Boundaries

The codebase should evolve toward these boundaries:

- `pricing`: price tables and overage estimation
- `telemetry`: raw snapshot collection and normalization
- `inference`: workload classification
- `policy`: spend policy and thresholds
- `decision-engine`: failure classification + candidate path ranking
- `presentation`: CLI and JSON formatting
- `packaging`: release/binary build concerns

This split is important. The current code combines recommendation, presentation, and parts of telemetry reasoning too closely. The new engine should be built around explicit boundaries so that packaging and Claude integration do not force logic churn.

## Recommended Next Step

The next step is to produce an implementation plan that:

- introduces normalized state and decision-result types,
- refactors the existing recommendation logic into a hybrid decision engine,
- adds spend-policy configuration,
- adds scenario-based tests,
- prepares standalone-binary release packaging,
- keeps the current CLI usable during the transition.
