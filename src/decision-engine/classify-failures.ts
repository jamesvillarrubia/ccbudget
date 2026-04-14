import type { FailureMode, ObservedState } from "./types.js";

const WEEKLY_SONNET_PRESSURE_PCT = 85;
const SESSION_PRESSURE_PCT = 90;
const GLOBAL_EXHAUST_SESSION_PCT = 98;
const GLOBAL_EXHAUST_WEEKLY_PCT = 95;

export function classifyFailureModes(state: ObservedState): FailureMode[] {
  const modes: FailureMode[] = [];
  const sessionPct = state.currentSessionPct ?? 0;
  const weeklySonnetPct = state.weeklySonnetPct ?? 0;

  if (sessionPct >= SESSION_PRESSURE_PCT) {
    modes.push("current-model-window-exhaustion");
  }

  if (weeklySonnetPct >= WEEKLY_SONNET_PRESSURE_PCT) {
    if (state.currentModel === "sonnet") {
      modes.push("current-model-cap-exhaustion");
    } else {
      modes.push("fallback-model-cap-exhaustion");
    }
  }

  if (
    sessionPct >= GLOBAL_EXHAUST_SESSION_PCT &&
    weeklySonnetPct >= GLOBAL_EXHAUST_WEEKLY_PCT
  ) {
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
