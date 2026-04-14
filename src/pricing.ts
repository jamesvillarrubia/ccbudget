import type { ModelPricePer1M } from "./types.js";

export type PricedModelId = "opus" | "sonnet" | "haiku";

export const DEFAULT_PRICES_PER_1M: Record<PricedModelId, ModelPricePer1M> = {
  opus: {
    input: 15,
    output: 75,
    cachedInput: 1.5,
  },
  sonnet: {
    input: 3,
    output: 15,
    cachedInput: 0.3,
  },
  haiku: {
    input: 0.8,
    output: 4,
    cachedInput: 0.08,
  },
};

export function readPricingFromEnv(): Record<PricedModelId, ModelPricePer1M> {
  const override = process.env.CLAUDE_MODEL_PRICES_JSON;
  if (!override) {
    return DEFAULT_PRICES_PER_1M;
  }

  try {
    const parsed = JSON.parse(override) as Record<string, ModelPricePer1M>;
    if (!parsed.opus || !parsed.sonnet) {
      return DEFAULT_PRICES_PER_1M;
    }
    return {
      opus: parsed.opus,
      sonnet: parsed.sonnet,
      haiku: parsed.haiku ?? DEFAULT_PRICES_PER_1M.haiku,
    };
  } catch {
    return DEFAULT_PRICES_PER_1M;
  }
}

export function weightedUsdPer1MTokens(m: ModelPricePer1M): number {
  return m.input * 0.6 + m.output * 0.3 + (m.cachedInput ?? m.input) * 0.1;
}

/** Estimates hourly paid cost from sustained token throughput for a single model. */
export function estimateOverageUsd(model: PricedModelId, tokensPerHour: number): number {
  const prices = readPricingFromEnv();
  return (tokensPerHour / 1_000_000) * weightedUsdPer1MTokens(prices[model]);
}

const PEAK_START_HOUR_PT = 5;
const PEAK_END_HOUR_PT = 11;

const PACIFIC_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  hour: "numeric",
  hour12: false,
});

const DAY_INDEX_BY_WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function toPacific(date: Date): { hour: number; dayOfWeek: number } {
  const parts = PACIFIC_TIME_FORMATTER.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const dayOfWeek = weekday ? DAY_INDEX_BY_WEEKDAY[weekday] : Number.NaN;

  if (!Number.isFinite(hour) || !Number.isFinite(dayOfWeek)) {
    throw new Error("Unable to derive Pacific time fields for peak-hour detection");
  }

  return { hour, dayOfWeek };
}

export function isPeakHour(date: Date = new Date()): boolean {
  const { hour, dayOfWeek } = toPacific(date);
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  return isWeekday && hour >= PEAK_START_HOUR_PT && hour < PEAK_END_HOUR_PT;
}

export function normalizeToOpusTpp(
  rawTokensPerPct: number,
  opusFraction: number,
): number {
  if (opusFraction >= 1) return rawTokensPerPct;
  if (opusFraction <= 0) return rawTokensPerPct;

  const prices = readPricingFromEnv();
  const opusCost = weightedUsdPer1MTokens(prices.opus);
  const sonnetCost = weightedUsdPer1MTokens(prices.sonnet);
  const sonnetFraction = 1 - opusFraction;
  const mixedCost = opusFraction * opusCost + sonnetFraction * sonnetCost;

  if (opusCost <= 0) return rawTokensPerPct;
  return rawTokensPerPct * (mixedCost / opusCost);
}
