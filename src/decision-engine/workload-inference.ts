import type { WorkloadInference } from "./types.js";

export interface WorkloadInput {
  currentBurnPctPerHour: number | null;
  currentSessionPct: number | null;
  resetsInMinutes: number | null;
  recentOpusFraction: number;
  burnVolatility: number;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function inferWorkload(input: WorkloadInput): WorkloadInference {
  const reasons: string[] = [];
  const burn = finiteNumber(input.currentBurnPctPerHour);
  const volatility = finiteNumber(input.burnVolatility);
  const recentOpusFraction = finiteNumber(input.recentOpusFraction);
  const sessionPct = finiteNumber(input.currentSessionPct);
  const resetsInMinutes = finiteNumber(input.resetsInMinutes);
  const highSessionPressure =
    sessionPct != null &&
    resetsInMinutes != null &&
    sessionPct >= 60 &&
    resetsInMinutes <= 180;
  const moderateSessionPressure =
    sessionPct != null &&
    resetsInMinutes != null &&
    sessionPct >= 30 &&
    resetsInMinutes <= 300;

  if (volatility != null && volatility >= 0.5) {
    reasons.push("Burn is highly volatile");
    return { workload: "spiky", confidence: 0.7, reasons };
  }
  if ((burn != null && burn >= 20) || (recentOpusFraction != null && recentOpusFraction >= 0.8) || highSessionPressure) {
    if ((burn != null && burn >= 20) || (recentOpusFraction != null && recentOpusFraction >= 0.8)) {
      reasons.push("Sustained high burn or strong Opus preference");
    }
    if (highSessionPressure) {
      reasons.push("Current session usage is already elevated with a short reset horizon");
    }
    return { workload: "heavy", confidence: 0.75, reasons };
  }
  if ((burn != null && burn >= 8) || moderateSessionPressure) {
    if (burn != null && burn >= 8) {
      reasons.push("Moderate sustained burn");
    }
    if (moderateSessionPressure) {
      reasons.push("Session usage suggests meaningful workload before the next reset");
    }
    return { workload: "normal", confidence: 0.65, reasons };
  }
  if (burn == null) {
    reasons.push("Burn signal is unavailable, so workload defaults to a neutral baseline");
    return { workload: "normal", confidence: 0.35, reasons };
  }
  reasons.push("Low sustained burn");
  return { workload: "light", confidence: 0.6, reasons };
}
