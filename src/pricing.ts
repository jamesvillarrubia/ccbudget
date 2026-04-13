import type { ModelPricePer1M } from "./types.js";

export const DEFAULT_PRICES_PER_1M: Record<"opus" | "sonnet", ModelPricePer1M> = {
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
};

export function readPricingFromEnv(): Record<"opus" | "sonnet", ModelPricePer1M> {
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
    };
  } catch {
    return DEFAULT_PRICES_PER_1M;
  }
}

const PEAK_START_HOUR_PT = 5;
const PEAK_END_HOUR_PT = 11;

function toPacific(date: Date): { hour: number; dayOfWeek: number } {
  const ptString = date.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const pt = new Date(ptString);
  return { hour: pt.getHours(), dayOfWeek: pt.getDay() };
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
  const weightedCost = (m: ModelPricePer1M) =>
    m.input * 0.6 + m.output * 0.3 + (m.cachedInput ?? m.input) * 0.1;

  const opusCost = weightedCost(prices.opus);
  const sonnetCost = weightedCost(prices.sonnet);
  const sonnetFraction = 1 - opusFraction;
  const mixedCost = opusFraction * opusCost + sonnetFraction * sonnetCost;

  if (opusCost <= 0) return rawTokensPerPct;
  return rawTokensPerPct * (mixedCost / opusCost);
}
