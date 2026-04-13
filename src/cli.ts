import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { collectSnapshotEvent, readHookPayload } from "./collectors.js";
import { buildRecommendation, estimateModelMix } from "./estimator.js";
import { isPeakHour, normalizeToOpusTpp } from "./pricing.js";
import { runCommand } from "./shell.js";
import {
  appendPricingHistory,
  getLatestSnapshotTsFast,
  readPricingBaseline,
  readRecentSnapshotsFromState,
  updateRollingStateWithSnapshot,
} from "./state.js";
import {
  acquireLock,
  appendSnapshot,
  getSnapshotFilePath,
  releaseLock,
} from "./storage.js";
import type { Recommendation, SnapshotEvent } from "./types.js";
import type { UsageAccountingSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      command.push(token);
      continue;
    }
    const [key, maybeValue] = token.slice(2).split("=");
    if (maybeValue !== undefined) {
      flags.set(key, maybeValue);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
      continue;
    }
    flags.set(key, true);
  }
  return { command, flags };
}

function getStringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function getNumberFlag(args: ParsedArgs, key: string, fallback: number): number {
  const value = args.flags.get(key);
  if (typeof value !== "string") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isoForFilename(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

async function runSnapshot(args: ParsedArgs): Promise<void> {
  const source = getStringFlag(args, "source") ?? "manual";
  const hookFile = getStringFlag(args, "hook-file");
  const hookPayload = await readHookPayload(hookFile).catch(() => undefined);
  const snapshot = await collectSnapshotEvent(source as "manual", hookPayload);
  await appendSnapshot(snapshot);
  await updateRollingStateWithSnapshot(snapshot);
  process.stdout.write(`${JSON.stringify({ ok: true, snapshot, file: getSnapshotFilePath() })}\n`);
}

// ---------------------------------------------------------------------------
// Advisor
// ---------------------------------------------------------------------------

async function runAdvisorNow(args: ParsedArgs): Promise<void> {
  const windowMinutes = getNumberFlag(args, "window-minutes", 300);
  const refresh = !args.flags.has("no-refresh");
  if (refresh) {
    try {
      const fresh = await collectSnapshotEvent("manual", undefined);
      await appendSnapshot(fresh);
      await updateRollingStateWithSnapshot(fresh);
    } catch {
      // Best-effort refresh
    }
  }
  const snapshots = await readRecentSnapshotsFromState(Math.max(windowMinutes, 180));
  const baseline = await readPricingBaseline();
  const recommendation = buildRecommendation(snapshots, windowMinutes, baseline);

  if (
    recommendation.currentTokensPerPct != null &&
    recommendation.currentTokensPerPct > 0 &&
    recommendation.sessionBurnPctPerHour != null &&
    recommendation.sessionBurnPctPerHour > 0
  ) {
    try {
      const mix = estimateModelMix(snapshots);
      const now = new Date();
      await appendPricingHistory({
        ts: now.toISOString(),
        tokensPerPct: recommendation.currentTokensPerPct,
        opusNormalizedTpp: normalizeToOpusTpp(recommendation.currentTokensPerPct, mix.opusFraction),
        burnPctPerHour: recommendation.sessionBurnPctPerHour,
        opusFraction: mix.opusFraction,
        isPeak: isPeakHour(now),
      });
    } catch {
      // non-critical
    }
  }

  const mode = args.command[1] ?? "now";

  if (mode === "hook-message") {
    const sonnetWarn = !recommendation.sonnetCapAvailable
      ? ` Sonnet weekly cap at ${Math.round(recommendation.weeklySonnetPct ?? 0)}% — not a viable fallback.`
      : "";
    const message = recommendation.willHitLimit
      ? recommendation.recommendedModel === "sonnet"
        ? `Switch to Sonnet — ${recommendation.timeToLimitMinutes ?? "?"}min to budget limit at current rate.`
        : `Budget is tight — ${recommendation.timeToLimitMinutes ?? "?"}min to limit.${sonnetWarn || " Consider Sonnet for routine tasks."}`
      : `Budget is comfortable — ${recommendation.timeToLimitMinutes != null ? `${(recommendation.timeToLimitMinutes / 60).toFixed(1)}h runway` : "no active burn"}.${sonnetWarn}`;
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        message,
        confidence: recommendation.confidence,
        recommendation: recommendation.recommendedModel,
      })}\n`,
    );
    return;
  }

  if (args.flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ ok: true, windowMinutes, recommendation }, null, 2)}\n`);
    return;
  }

  printAdvisorHuman(recommendation);
}

// ---------------------------------------------------------------------------
// Human-readable advisor output
// ---------------------------------------------------------------------------

function progressBar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

const SESSION_WINDOW_HRS = 5;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return `${n.toFixed(0)}`;
}

function fmtDuration(hours: number): string {
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours * 60)}min`;
}

function printAdvisorHuman(rec: Recommendation): void {
  const w = process.stdout.columns || 60;
  const line = "\u2500".repeat(Math.min(w, 52));
  const out = (s: string) => process.stdout.write(s + "\n");

  out("");
  const peakLabel = rec.isPeak ? " [PEAK]" : " [off-peak]";
  out(`  Claude Budget Advisor${peakLabel}`);
  out(`  ${line}`);

  if (rec.sessionPct != null) {
    out(`  Session    ${progressBar(rec.sessionPct)}  ${Math.round(rec.sessionPct)}%`);
  }

  if (rec.sessionBurnPctPerHour != null && rec.sessionBurnPctPerHour > 0) {
    out(`  Burn rate  ${rec.sessionBurnPctPerHour.toFixed(1)}%/hr`);
  } else {
    out("  Burn rate  idle");
  }

  if (rec.windowResetsInMinutes != null) {
    const hrs = rec.windowResetsInMinutes / 60;
    out(`  Resets in  ${hrs >= 1 ? `${hrs.toFixed(1)}h` : `${rec.windowResetsInMinutes}min`}`);
  }

  if (rec.projectedEndPct != null) {
    out(`  Projected  ${rec.projectedEndPct.toFixed(0)}% at window end`);
  }

  out("");

  if (rec.willHitLimit) {
    const label = rec.recommendedModel === "sonnet" ? "USE SONNET" : "BUDGET IS TIGHT";
    out(`  >>> ${label} <<<`);
  } else if (rec.sessionBurnPctPerHour != null && rec.sessionBurnPctPerHour > 0) {
    const label = rec.recommendedModel === "opus" ? "OPUS IS FINE" : "EITHER MODEL OK";
    out(`  ${label}`);
  } else {
    out("  IDLE");
  }

  out("");

  // Pricing vs baseline (Opus-normalized, peak/off-peak bucketed)
  if (rec.currentTokensPerPct != null) {
    out(`  Budget     ${fmtTokens(rec.currentTokensPerPct)} tokens per 1%`);
    if (rec.baselineTokensPerPct != null) {
      const bucketLabel = rec.isPeak ? "peak" : "off-peak";
      out(`             Your ${bucketLabel} avg: ${fmtTokens(rec.baselineTokensPerPct)} tokens per 1%`);
    }
    if (rec.pricingVsBaseline != null) {
      const pct = Math.abs(rec.pricingVsBaseline).toFixed(0);
      if (rec.pricingVsBaseline > 0) {
        out(`             Anthropic pricing ${pct}% higher than your ${rec.isPeak ? "peak" : "off-peak"} norm`);
      } else {
        out(`             Anthropic pricing ${pct}% lower than your ${rec.isPeak ? "peak" : "off-peak"} norm`);
      }
    }
    out("");
  }

  // Sonnet weekly cap — with timing based on weekly average
  if (rec.weeklySonnetPct != null) {
    const warn = !rec.sonnetCapAvailable ? " \u26A0 NEAR CAP" : "";
    out(`  Sonnet     ${progressBar(rec.weeklySonnetPct)}  ${Math.round(rec.weeklySonnetPct)}% weekly${warn}`);

    // Show rates: prefer avg (includes idle hours), note instantaneous if different
    const avgRate = rec.weeklySonnetAvgBurnPctPerHour;
    const instantRate = rec.weeklySonnetBurnPctPerHour;
    if (avgRate != null && avgRate > 0) {
      let rateLabel = `${avgRate.toFixed(1)}%/hr avg this week`;
      if (instantRate != null && instantRate > 0 && Math.abs(instantRate - avgRate) / avgRate > 0.2) {
        rateLabel += ` (${instantRate.toFixed(1)}%/hr right now)`;
      }
      out(`             ${rateLabel}`);
    } else if (instantRate != null && instantRate > 0) {
      out(`             ${instantRate.toFixed(1)}%/hr (current session only)`);
    }

    // Use the best rate for cap timing: avg > instantaneous
    const projRate = avgRate ?? instantRate;
    const hoursToSonnetCap =
      projRate != null && projRate > 0 && rec.weeklySonnetPct < 100
        ? (100 - rec.weeklySonnetPct) / projRate
        : undefined;

    if (rec.weeklySonnetHitsLimit && hoursToSonnetCap != null) {
      const beforeReset = rec.weeklySonnetResetsInHours != null
        ? ` (${fmtDuration(rec.weeklySonnetResetsInHours - hoursToSonnetCap)} before reset)`
        : "";
      out(`             \u2192 hits cap in ~${fmtDuration(hoursToSonnetCap)}${beforeReset}`);
    } else if (rec.weeklySonnetProjectedEndPct != null) {
      out(`             Projected ${Math.round(rec.weeklySonnetProjectedEndPct)}% at reset`);
    }

    if (rec.weeklySonnetResetsInHours != null) {
      out(`             resets in ${fmtDuration(rec.weeklySonnetResetsInHours)}`);
    }
  }

  out("");

  // Model survival comparison
  if (rec.willHitLimit && rec.sonnetEquivBurnRate != null && rec.sonnetEquivBurnRate > 0) {
    if (rec.sonnetCapAvailable) {
      const remainHrs = (rec.windowResetsInMinutes ?? SESSION_WINDOW_HRS * 60) / 60;
      const sonnetEndPct = Math.min(100, (rec.sessionPct ?? 0) + rec.sonnetEquivBurnRate * remainHrs);
      out(`  On Sonnet  \u2192 ~${sonnetEndPct.toFixed(0)}% session at window end${sonnetEndPct < 100 ? " (safe)" : ""}`);
    } else {
      out(`  On Sonnet  \u2192 NOT VIABLE (weekly cap at ${Math.round(rec.weeklySonnetPct ?? 0)}%)`);
    }
  }

  out("");

  if (rec.dataPoints != null) {
    let meta = `  ${rec.dataPoints} samples`;
    if (rec.elapsedMinutes != null) meta += ` over ${rec.elapsedMinutes}min`;
    meta += ` (confidence: ${(rec.confidence * 100).toFixed(0)}%)`;
    out(meta);
  }

  out(`  ${line}`);
  out("");
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

async function runBaseline(args: ParsedArgs): Promise<void> {
  const outputDir = getStringFlag(args, "output-dir") ?? "baselines";
  const windowMinutes = getNumberFlag(args, "window-minutes", 300);
  const strict = !args.flags.has("allow-missing-usage");
  const requireAccounting = !args.flags.has("allow-missing-accounting");
  const quiet = args.flags.has("quiet");
  const now = new Date();
  const ts = isoForFilename(now);

  await mkdir(outputDir, { recursive: true });

  const snapshot = await collectSnapshotEvent("manual", undefined);
  await appendSnapshot(snapshot);
  await updateRollingStateWithSnapshot(snapshot);

  const snapshots = await readRecentSnapshotsFromState(Math.max(windowMinutes, 180));
  const pricingBaseline = await readPricingBaseline();
  const recommendation = buildRecommendation(snapshots, windowMinutes, pricingBaseline);

  const usageAccounting = snapshot.accounting;

  const snapshotPath = join(outputDir, `${ts}-snapshot.json`);
  const advisorPath = join(outputDir, `${ts}-advisor.json`);
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await writeFile(
    advisorPath,
    `${JSON.stringify({ ts: now.toISOString(), windowMinutes, recommendation }, null, 2)}\n`,
    "utf8",
  );

  const raw = (snapshot.usageRaw ?? {}) as Record<string, unknown>;
  const sessionPath = join(outputDir, `${ts}-session.json`);
  const weeklyPath = join(outputDir, `${ts}-weekly.json`);
  const weeklySonnetPath = join(outputDir, `${ts}-weekly-sonnet.json`);
  await writeFile(sessionPath, `${JSON.stringify(raw.session ?? {}, null, 2)}\n`, "utf8");
  await writeFile(weeklyPath, `${JSON.stringify(raw.weekly ?? {}, null, 2)}\n`, "utf8");
  await writeFile(weeklySonnetPath, `${JSON.stringify(raw["weekly-sonnet"] ?? {}, null, 2)}\n`, "utf8");

  const usageSummary = {
    sessionPct: toNumberOrNull(snapshot.usage?.sessionPct),
    weeklyPct: toNumberOrNull(snapshot.usage?.weeklyPct),
    weeklySonnetPct: toNumberOrNull(snapshot.usage?.weeklySonnetPct),
  };

  if (strict && (usageSummary.sessionPct === null || usageSummary.weeklyPct === null || usageSummary.weeklySonnetPct === null)) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: "missing-usage-windows",
          message: "Missing one or more usage windows from ccburn. Ensure ccburn can read your active Claude usage and retry. Use --allow-missing-usage to bypass.",
          usage: usageSummary,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 2;
    return;
  }

  if (requireAccounting && typeof usageAccounting?.totalTokensCumulative !== "number") {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: "missing-usage-accounting",
          message: "Missing ccusage accounting data. Ensure ccusage works in this shell and retry. Use --allow-missing-accounting to bypass.",
          usageAccounting: usageAccounting ?? null,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 3;
    return;
  }

  const baselinePath = join(outputDir, `${ts}-baseline.json`);
  const baselinePayload = {
    ts: now.toISOString(),
    windowMinutes,
    usage: usageSummary,
    recommendation: recommendation.recommendedModel,
    confidence: recommendation.confidence,
    burnPctPerHour: recommendation.sessionBurnPctPerHour ?? 0,
    timeToLimitMinutes: recommendation.timeToLimitMinutes ?? null,
    currentTokensPerPct: recommendation.currentTokensPerPct ?? null,
    usageAccounting,
    reasons: recommendation.reason,
    files: {
      snapshot: snapshotPath,
      advisor: advisorPath,
      session: sessionPath,
      weekly: weeklyPath,
      weeklySonnet: weeklySonnetPath,
    },
  };

  await writeFile(baselinePath, `${JSON.stringify(baselinePayload, null, 2)}\n`, "utf8");

  if (!quiet) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          ts: now.toISOString(),
          outputDir,
          usage: usageSummary,
          recommendation: recommendation.recommendedModel,
          confidence: recommendation.confidence,
          usageAccounting: usageAccounting ?? null,
          baselineFile: baselinePath,
          files: {
            snapshot: snapshotPath,
            advisor: advisorPath,
            session: sessionPath,
            weekly: weeklyPath,
            weeklySonnet: weeklySonnetPath,
          },
        },
        null,
        2,
      )}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

interface BaselineFile {
  ts: string;
  windowMinutes: number;
  usage: { sessionPct: number | null; weeklyPct: number | null; weeklySonnetPct: number | null };
  recommendation?: string;
  confidence?: number;
  burnPctPerHour?: number;
  usageAccounting?: UsageAccountingSnapshot;
  reasons?: string[];
}

async function readBaselineFile(path: string): Promise<BaselineFile> {
  return JSON.parse(await readFile(path, "utf8")) as BaselineFile;
}

async function listBaselineFiles(outputDir: string): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  const names = await readdir(outputDir);
  return names.filter((name) => name.endsWith("-baseline.json")).sort().map((name) => join(outputDir, name));
}

async function listValidBaselineFiles(outputDir: string): Promise<string[]> {
  const files = await listBaselineFiles(outputDir);
  const valid: string[] = [];
  for (const file of files) {
    try {
      const baseline = await readBaselineFile(file);
      if (typeof baseline.usage.sessionPct === "number" && typeof baseline.usageAccounting?.totalTokensCumulative === "number") {
        valid.push(file);
      }
    } catch {
      // skip
    }
  }
  return valid;
}

function safeDelta(after: number | null, before: number | null, digits = 2): number | null {
  if (typeof after !== "number" || typeof before !== "number") {
    return null;
  }
  return Number((after - before).toFixed(digits));
}

async function computeHistoricalTokensPerPercentAverage(beforePath: string, afterPath: string): Promise<number | null> {
  const directory = dirname(beforePath);
  const names = await readdir(directory);
  const baselineFiles = names.filter((name) => name.endsWith("-baseline.json")).sort();
  const absolute = baselineFiles.map((name) => join(directory, name));

  const pairs: { before: BaselineFile; after: BaselineFile }[] = [];
  for (let i = 1; i < absolute.length; i += 1) {
    const candidateBefore = absolute[i - 1];
    const candidateAfter = absolute[i];
    if (
      (candidateBefore === beforePath && candidateAfter === afterPath) ||
      (candidateBefore === afterPath && candidateAfter === beforePath)
    ) {
      continue;
    }
    const b = await readBaselineFile(candidateBefore);
    const a = await readBaselineFile(candidateAfter);
    pairs.push({ before: b, after: a });
  }

  const values: number[] = [];
  for (const pair of pairs) {
    const tokenDelta = safeDelta(
      pair.after.usageAccounting?.totalTokensCumulative ?? null,
      pair.before.usageAccounting?.totalTokensCumulative ?? null,
      4,
    );
    const pctDelta = safeDelta(pair.after.usage.sessionPct, pair.before.usage.sessionPct, 4);
    if (typeof tokenDelta !== "number" || typeof pctDelta !== "number" || pctDelta <= 0 || tokenDelta <= 0) {
      continue;
    }
    values.push(tokenDelta / pctDelta);
  }

  if (values.length === 0) {
    return null;
  }
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

async function compareBaselines(beforePath: string, afterPath: string, before: BaselineFile, after: BaselineFile) {
  const delta = {
    sessionPct: safeDelta(after.usage.sessionPct, before.usage.sessionPct, 2),
    weeklyPct: safeDelta(after.usage.weeklyPct, before.usage.weeklyPct, 2),
    weeklySonnetPct: safeDelta(after.usage.weeklySonnetPct, before.usage.weeklySonnetPct, 2),
    totalTokensCumulative: safeDelta(
      after.usageAccounting?.totalTokensCumulative ?? null,
      before.usageAccounting?.totalTokensCumulative ?? null,
      0,
    ),
    sonnetTokensCumulative: safeDelta(
      after.usageAccounting?.sonnetTokensCumulative ?? null,
      before.usageAccounting?.sonnetTokensCumulative ?? null,
      0,
    ),
    opusTokensCumulative: safeDelta(
      after.usageAccounting?.opusTokensCumulative ?? null,
      before.usageAccounting?.opusTokensCumulative ?? null,
      0,
    ),
  };

  const tokensPerOnePercent =
    typeof delta.totalTokensCumulative === "number" && typeof delta.sessionPct === "number" && delta.sessionPct > 0
      ? Number((delta.totalTokensCumulative / delta.sessionPct).toFixed(0))
      : null;
  const targetAverageTokensPerOnePercent = await computeHistoricalTokensPerPercentAverage(beforePath, afterPath);

  const aboveTargetByPercent =
    typeof tokensPerOnePercent === "number" && typeof targetAverageTokensPerOnePercent === "number" && targetAverageTokensPerOnePercent > 0
      ? Number(
          (((tokensPerOnePercent - targetAverageTokensPerOnePercent) / targetAverageTokensPerOnePercent) * 100).toFixed(2),
        )
      : null;

  const likelyModelThisInterval =
    typeof delta.sonnetTokensCumulative === "number" && typeof delta.opusTokensCumulative === "number" && delta.sonnetTokensCumulative > delta.opusTokensCumulative
      ? "sonnet"
      : typeof delta.sonnetTokensCumulative === "number" && typeof delta.opusTokensCumulative === "number" && delta.opusTokensCumulative > delta.sonnetTokensCumulative
        ? "opus"
        : "unknown";

  return {
    delta,
    efficiency: {
      tokensPerOnePercent,
      targetAverageTokensPerOnePercent: targetAverageTokensPerOnePercent === null ? null : Number(targetAverageTokensPerOnePercent.toFixed(0)),
      aboveTargetByPercent,
    },
    likelyModelThisInterval,
  };
}

async function runCompare(args: ParsedArgs): Promise<void> {
  const beforePath = getStringFlag(args, "before");
  const afterPath = getStringFlag(args, "after");

  if (!beforePath || !afterPath) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: "missing-args",
          message: "compare requires --before <baseline.json> and --after <baseline.json>",
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const before = await readBaselineFile(beforePath);
  const after = await readBaselineFile(afterPath);
  const comparison = await compareBaselines(beforePath, afterPath, before, after);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        before: {
          ts: before.ts,
          recommendation: before.recommendation ?? null,
          confidence: before.confidence ?? null,
        },
        after: {
          ts: after.ts,
          recommendation: after.recommendation ?? null,
          confidence: after.confidence ?? null,
        },
        delta: comparison.delta,
        efficiency: comparison.efficiency,
        likelyModelThisInterval: comparison.likelyModelThisInterval,
      },
      null,
      2,
    )}\n`,
  );
}

// ---------------------------------------------------------------------------
// Pulse
// ---------------------------------------------------------------------------

function buildPulseAction(model: string, sessionDelta: number | null, aboveTargetByPercent: number | null) {
  if (sessionDelta === null || sessionDelta <= 0) {
    return {
      verdict: "No measurable session burn in this interval.",
      action: "Run another request, then run `pnpm pulse` again.",
    };
  }
  if (aboveTargetByPercent === null) {
    return {
      verdict: "Not enough history for target comparison yet.",
      action: "Keep collecting pulses; recommendation quality improves after a few intervals.",
    };
  }
  const expensive = aboveTargetByPercent <= -20;
  const cheap = aboveTargetByPercent >= 20;
  if (model === "opus") {
    if (expensive) {
      return {
        verdict: "Opus is expensive right now (high budget pressure per token).",
        action: "Switch to Sonnet for routine tasks until pressure normalizes.",
      };
    }
    if (cheap) {
      return {
        verdict: "Opus is relatively cheap right now.",
        action: "Using Opus now is reasonable for high-value work.",
      };
    }
    return {
      verdict: "Opus is near normal efficiency.",
      action: "Use Opus selectively; Sonnet remains the default cost-safe choice.",
    };
  }
  if (model === "sonnet") {
    if (expensive) {
      return {
        verdict: "Even Sonnet is under heavy budget pressure now.",
        action: "Stay on Sonnet and reduce context/tool-heavy prompts for now.",
      };
    }
    if (cheap) {
      return {
        verdict: "Sonnet is cheap right now.",
        action: "Keep using Sonnet; this is a cost-efficient interval.",
      };
    }
    return {
      verdict: "Sonnet is near normal efficiency.",
      action: "Keep using Sonnet unless you need Opus-level quality.",
    };
  }
  return {
    verdict: "Model inference is unknown for this interval.",
    action: "Run one model consistently for a short window, then pulse again.",
  };
}

async function runPulse(args: ParsedArgs): Promise<void> {
  const outputDir = getStringFlag(args, "output-dir") ?? "baselines";
  args.flags.set("quiet", true);
  await runBaseline(args);

  const baselineFiles = await listValidBaselineFiles(outputDir);
  if (baselineFiles.length < 2) {
    process.stdout.write("Not enough baselines yet. Run `pnpm pulse` again after a request.\n");
    return;
  }

  const afterPath = baselineFiles.at(-1)!;
  const beforePath = baselineFiles.at(-2)!;
  const before = await readBaselineFile(beforePath);
  const after = await readBaselineFile(afterPath);
  const comparison = await compareBaselines(beforePath, afterPath, before, after);

  const session = after.usage.sessionPct;
  const sessionDelta = comparison.delta.sessionPct;
  const tokensPerPct = comparison.efficiency.tokensPerOnePercent;
  const target = comparison.efficiency.targetAverageTokensPerOnePercent;
  const above = comparison.efficiency.aboveTargetByPercent;
  const pulseAction = buildPulseAction(comparison.likelyModelThisInterval, sessionDelta, above);

  process.stdout.write("\n=== Claude Usage Pulse ===\n");
  process.stdout.write(
    `Session: ${session === null ? "n/a" : `${session}%`} (${sessionDelta === null ? "n/a" : `${sessionDelta >= 0 ? "+" : ""}${sessionDelta}%`})\n`,
  );
  process.stdout.write(`Likely model: ${comparison.likelyModelThisInterval}\n`);
  process.stdout.write(`1% usage ~= ${tokensPerPct === null ? "n/a" : tokensPerPct.toLocaleString()} tokens\n`);
  process.stdout.write(`Target 1% avg: ${target === null ? "n/a" : target.toLocaleString()} tokens\n`);
  process.stdout.write(
    `Vs target: ${above === null ? "n/a" : `${above >= 0 ? "+" : ""}${above}% ${above >= 0 ? "above" : "below"} avg`}\n`,
  );
  process.stdout.write(`Verdict: ${pulseAction.verdict}\n`);
  process.stdout.write(`Action: ${pulseAction.action}\n`);
  process.stdout.write(`Compared: ${beforePath} -> ${afterPath}\n\n`);
}

// ---------------------------------------------------------------------------
// Scheduler (cross-platform)
// ---------------------------------------------------------------------------

function getPlatform(): "darwin" | "linux" | "win32" | "other" {
  if (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32") {
    return process.platform;
  }
  return "other";
}

async function resolvePnpmBinary(): Promise<string> {
  const explicit = process.env.PNPM_BIN;
  if (explicit) {
    return explicit;
  }
  const probe = await runCommand("zsh", ["-lc", "command -v pnpm"]);
  if (probe.ok) {
    const path = probe.stdout.trim();
    if (path) {
      return path;
    }
  }
  return "pnpm";
}

async function installDarwinPlistFromTemplate(plistPath: string) {
  const templatePath = join(process.cwd(), "templates", "launchd", "com.claude.usage-advisor.plist");
  try {
    const template = await readFile(templatePath, "utf8");
    const pnpmBin = await resolvePnpmBinary();
    const rendered = template
      .replaceAll("{{PROJECT_DIR}}", process.cwd())
      .replaceAll("{{PNPM_BIN}}", pnpmBin)
      .replaceAll("{{PATH}}", process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin");
    await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath, rendered, "utf8");
    return { ok: true, details: `installed launchd plist from template with pnpm at ${pnpmBin}` };
  } catch (error) {
    return {
      ok: false,
      details: `failed to install launchd plist from template: ${(error as Error).message}`,
    };
  }
}

async function runScheduler(args: ParsedArgs): Promise<void> {
  const mode = args.command[1] ?? "status";
  if (!["status", "ensure", "disable"].includes(mode)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: "invalid-mode", message: "scheduler mode must be one of: status, ensure, disable" }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const platform = getPlatform();
  if (platform === "darwin") {
    await runSchedulerDarwin(mode, args);
    return;
  }
  if (platform === "linux") {
    await runSchedulerLinux(mode);
    return;
  }
  if (platform === "win32") {
    await runSchedulerWindows(mode, args);
    return;
  }

  process.stdout.write(
    `${JSON.stringify({ ok: false, error: "unsupported-platform", platform: process.platform }, null, 2)}\n`,
  );
  process.exitCode = 1;
}

async function runSchedulerDarwin(mode: string, args: ParsedArgs): Promise<void> {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "501";
  const label = `gui/${uid}/com.claude.usage-advisor`;
  const plistPath =
    getStringFlag(args, "plist-path") ?? join(homedir(), "Library", "LaunchAgents", "com.claude.usage-advisor.plist");

  const printResult = await runCommand("launchctl", ["print", label]);
  const running = printResult.ok && /state = running/.test(printResult.stdout);

  if (mode === "status") {
    process.stdout.write(
      `${JSON.stringify({ ok: printResult.ok, platform: "darwin", running, label, plistPath, summary: printResult.ok ? "scheduler found" : "scheduler not loaded" }, null, 2)}\n`,
    );
    return;
  }

  if (mode === "disable") {
    const bootoutByLabel = await runCommand("launchctl", ["bootout", `gui/${uid}`, label]);
    if (!bootoutByLabel.ok) {
      await runCommand("launchctl", ["bootout", `gui/${uid}`, plistPath]);
    }
    await runCommand("launchctl", ["disable", label]);
    process.stdout.write(
      `${JSON.stringify({ ok: true, platform: "darwin", action: "disable", label, details: "requested scheduler disable and unload" }, null, 2)}\n`,
    );
    return;
  }

  if (printResult.ok) {
    const kick = await runCommand("launchctl", ["kickstart", "-k", label]);
    const post = await runCommand("launchctl", ["print", label]);
    const healthy = post.ok && /state = running/.test(post.stdout);
    process.stdout.write(
      `${JSON.stringify({
        ok: kick.ok || healthy,
        platform: "darwin",
        action: "kickstart",
        label,
        details: kick.ok ? "restarted existing scheduler" : healthy ? "scheduler is running (kickstart returned non-zero but service is healthy)" : kick.stderr || "kickstart failed and scheduler not running",
      }, null, 2)}\n`,
    );
    process.exitCode = kick.ok || healthy ? 0 : 1;
    return;
  }

  try {
    await access(plistPath);
  } catch {
    const installed = await installDarwinPlistFromTemplate(plistPath);
    if (!installed.ok) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, platform: "darwin", error: "missing-plist", message: installed.details, plistPath }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const bootstrap = await runCommand("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  if (!bootstrap.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, platform: "darwin", action: "bootstrap", label, details: bootstrap.stderr }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  await runCommand("launchctl", ["enable", label]);
  const kick = await runCommand("launchctl", ["kickstart", "-k", label]);
  const post = await runCommand("launchctl", ["print", label]);
  const healthy = post.ok && /state = running/.test(post.stdout);
  process.stdout.write(
    `${JSON.stringify({
      ok: kick.ok || healthy,
      platform: "darwin",
      action: "bootstrap+kickstart",
      label,
      details: kick.ok ? "bootstrapped and started scheduler" : healthy ? "scheduler is running (kickstart returned non-zero but service is healthy)" : kick.stderr || "bootstrap succeeded but kickstart failed and service is not running",
    }, null, 2)}\n`,
  );
  process.exitCode = kick.ok || healthy ? 0 : 1;
}

async function runSchedulerLinux(mode: string): Promise<void> {
  const timer = "claude-usage-advisor.timer";
  const service = "claude-usage-advisor.service";
  const active = await runCommand("systemctl", ["--user", "is-active", timer]);
  const enabled = await runCommand("systemctl", ["--user", "is-enabled", timer]);
  const isRunning = active.ok && active.stdout.trim() === "active";

  if (mode === "status") {
    process.stdout.write(
      `${JSON.stringify({ ok: active.ok || enabled.ok, platform: "linux", running: isRunning, timer, service, active: active.stdout.trim() || active.stderr.trim() || "unknown", enabled: enabled.stdout.trim() || enabled.stderr.trim() || "unknown" }, null, 2)}\n`,
    );
    return;
  }

  if (mode === "disable") {
    const disableNow = await runCommand("systemctl", ["--user", "disable", "--now", timer]);
    await runCommand("systemctl", ["--user", "stop", service]);
    process.stdout.write(
      `${JSON.stringify({ ok: disableNow.ok, platform: "linux", action: "disable", timer, service, details: disableNow.ok ? "disabled and stopped timer/service" : disableNow.stderr }, null, 2)}\n`,
    );
    process.exitCode = disableNow.ok ? 0 : 1;
    return;
  }

  await runCommand("systemctl", ["--user", "daemon-reload"]);
  const enableNow = await runCommand("systemctl", ["--user", "enable", "--now", timer]);
  if (!enableNow.ok) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, platform: "linux", action: "enable-now", timer, details: enableNow.stderr }, null, 2)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  await runCommand("systemctl", ["--user", "start", service]);
  const final = await runCommand("systemctl", ["--user", "is-active", timer]);
  process.stdout.write(
    `${JSON.stringify({ ok: final.ok && final.stdout.trim() === "active", platform: "linux", action: "enable+start", timer, service, state: final.stdout.trim() || final.stderr.trim() }, null, 2)}\n`,
  );
}

async function runSchedulerWindows(mode: string, args: ParsedArgs): Promise<void> {
  const taskName = getStringFlag(args, "task-name") ?? "claude-usage-advisor";
  const xmlPath = getStringFlag(args, "xml-path");
  const query = await runCommand("schtasks", ["/Query", "/TN", taskName, "/FO", "LIST"]);

  if (mode === "status") {
    process.stdout.write(
      `${JSON.stringify({ ok: query.ok, platform: "win32", taskName, running: query.ok, details: query.ok ? "task exists" : query.stderr }, null, 2)}\n`,
    );
    return;
  }

  if (mode === "disable") {
    await runCommand("schtasks", ["/End", "/TN", taskName]);
    const disable = await runCommand("schtasks", ["/Change", "/TN", taskName, "/DISABLE"]);
    process.stdout.write(
      `${JSON.stringify({ ok: disable.ok, platform: "win32", action: "disable", taskName, details: disable.ok ? "task disabled" : disable.stderr }, null, 2)}\n`,
    );
    process.exitCode = disable.ok ? 0 : 1;
    return;
  }

  if (!query.ok) {
    if (!xmlPath) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, platform: "win32", error: "missing-task", message: "Task not found. Provide --xml-path to create it from template.", taskName }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const create = await runCommand("schtasks", ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
    if (!create.ok) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, platform: "win32", action: "create", taskName, details: create.stderr }, null, 2)}\n`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const run = await runCommand("schtasks", ["/Run", "/TN", taskName]);
  process.stdout.write(
    `${JSON.stringify({ ok: run.ok, platform: "win32", action: "run", taskName, details: run.ok ? "task started" : run.stderr }, null, 2)}\n`,
  );
  process.exitCode = run.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(args: ParsedArgs): Promise<void> {
  const mode = args.command[1] ?? "run";
  const intervalSeconds = getNumberFlag(args, "interval-seconds", 300);
  const staleSeconds = getNumberFlag(args, "stale-seconds", 420);

  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, message: "collector-lock-active", file: getSnapshotFilePath() })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  let stopping = false;
  const cleanShutdown = () => {
    if (stopping) return;
    stopping = true;
    releaseLock().finally(() => process.exit(0));
  };
  process.on("SIGTERM", cleanShutdown);
  process.on("SIGINT", cleanShutdown);

  const maybeCollect = async () => {
    const latest = await getLatestSnapshotTsFast();
    if (latest) {
      const ageSeconds = (Date.now() - latest.getTime()) / 1000;
      if (ageSeconds < staleSeconds) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, skipped: true, reason: "fresh-snapshot", ageSeconds })}\n`,
        );
        return;
      }
    }
    const snapshot = await collectSnapshotEvent("watchdog", undefined);
    await appendSnapshot(snapshot);
    await updateRollingStateWithSnapshot(snapshot);
    process.stdout.write(`${JSON.stringify({ ok: true, collected: true, snapshotTs: snapshot.ts })}\n`);
  };

  if (mode === "once") {
    try {
      await maybeCollect();
    } finally {
      await releaseLock();
    }
    return;
  }

  try {
    while (!stopping) {
      await maybeCollect();
      await sleep(intervalSeconds * 1000);
    }
  } finally {
    await releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Help / main
// ---------------------------------------------------------------------------

function usage(): void {
  process.stdout.write(
    [
      "Usage:",
      "  snapshot [--source manual|hook|statusline|watchdog] [--hook-file path]",
      "  baseline [--output-dir baselines] [--window-minutes 300] [--allow-missing-usage] [--allow-missing-accounting]",
      "  pulse [--output-dir baselines] [--window-minutes 300]",
      "  compare --before <baseline.json> --after <baseline.json>",
      "  scheduler status|ensure|disable [--plist-path ...] [--task-name ...] [--xml-path ...]",
      "  advisor now|hook-message [--window-minutes 300] [--no-refresh]",
      "  daemon once|run [--interval-seconds 300] [--stale-seconds 420]",
      "",
      "Examples:",
      "  pnpm snapshot --source hook --hook-file /tmp/claude-hook.json",
      "  pnpm pulse",
      "  pnpm tsx src/cli.ts baseline --output-dir baselines",
      "  pnpm tsx src/cli.ts compare --before baselines/a.json --after baselines/b.json",
      "  pnpm tsx src/cli.ts scheduler status",
      "  pnpm tsx src/cli.ts scheduler ensure",
      "  pnpm tsx src/cli.ts scheduler disable",
      "  pnpm advisor --window-minutes 300",
      "  pnpm daemon --interval-seconds 300 --stale-seconds 420",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = args.command[0];
  switch (root) {
    case "snapshot":
      await runSnapshot(args);
      break;
    case "advisor":
      await runAdvisorNow(args);
      break;
    case "baseline":
      await runBaseline(args);
      break;
    case "compare":
      await runCompare(args);
      break;
    case "pulse":
      await runPulse(args);
      break;
    case "daemon":
      await runDaemon(args);
      break;
    case "scheduler":
      await runScheduler(args);
      break;
    default:
      usage();
      process.exitCode = 1;
  }
}

await main();
