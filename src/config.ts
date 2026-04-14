import type { SpendPolicy } from "./decision-engine/types.js";

function num(value: string | undefined, fallback = 0): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(parsed, 0);
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
