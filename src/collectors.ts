import { readFile } from "node:fs/promises";
import { runCommand } from "./shell.js";
import type { CcburnSignal, SnapshotEvent, SnapshotSource, TokenSnapshot, UsageAccountingSnapshot, WindowUsageSnapshot } from "./types.js";

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const stripped = value.replace("%", "").trim();
    const parsed = Number(stripped);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizePercent(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value >= 0 && value <= 1) {
    return value * 100;
  }
  return value;
}

function findNumberByKey(input: unknown, keys: string[]): number | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const stack: unknown[] = [input];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null) {
      continue;
    }
    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }
    for (const [key, value] of Object.entries(current as Record<string, unknown>)) {
      if (keys.includes(key.toLowerCase())) {
        const maybe = numeric(value);
        if (maybe !== undefined) {
          return maybe;
        }
      }
      stack.push(value);
    }
  }
  return undefined;
}

function parseJsonFromMixedOutput(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace < 0) {
    return undefined;
  }
  for (let i = firstBrace; i < trimmed.length; i += 1) {
    if (trimmed[i] !== "{") {
      continue;
    }
    const candidate = trimmed.slice(i);
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return undefined;
}

let resolvedCcburn: string[] | null | undefined;

async function resolveCcburnCmd(): Promise<string[] | null> {
  if (resolvedCcburn !== undefined) return resolvedCcburn;

  const direct = await runCommand("ccburn", ["--version"], 5_000);
  if (direct.ok) {
    resolvedCcburn = ["ccburn"];
    return resolvedCcburn;
  }
  const dlx = await runCommand("pnpm", ["dlx", "ccburn", "--version"], 15_000);
  if (dlx.ok) {
    resolvedCcburn = ["pnpm", "dlx", "ccburn"];
    return resolvedCcburn;
  }
  resolvedCcburn = null;
  return null;
}

async function runCcburnJson(subcommand: string): Promise<unknown | undefined> {
  const cmd = await resolveCcburnCmd();
  if (!cmd) return undefined;

  const args = [...cmd.slice(1), subcommand, "--json", "--once"];
  const result = await runCommand(cmd[0], args, 45_000);
  if (!result.ok || !result.stdout.trim()) return undefined;
  return parseJsonFromMixedOutput(result.stdout);
}

async function collectCcburnUsage(): Promise<{ usage?: WindowUsageSnapshot; raw?: unknown }> {
  const windows = [
    { key: "sessionPct", subcommand: "session" },
    { key: "weeklyPct", subcommand: "weekly" },
    { key: "weeklySonnetPct", subcommand: "weekly-sonnet" },
  ] as const;

  const usage: WindowUsageSnapshot = {};
  const raw: Record<string, unknown> = {};

  for (const window of windows) {
    const parsed = await runCcburnJson(window.subcommand);
    if (!parsed) {
      continue;
    }

    raw[window.subcommand] = parsed;
    const limitsObj = (parsed as { limits?: Record<string, Record<string, unknown>> }).limits?.[window.subcommand];
    const nestedUtilization = numeric(limitsObj?.utilization);
    const percent = normalizePercent(
      nestedUtilization ??
        findNumberByKey(parsed, ["utilization", "percent", "usage_percent", "usagepct", "usage"]),
    );
    if (percent !== undefined) {
      (usage as Record<string, unknown>)[window.key] = percent;
    }
    if (window.key === "sessionPct" && limitsObj) {
      const resetsIn = numeric(limitsObj.resets_in_minutes);
      if (resetsIn !== undefined) {
        usage.sessionResetsInMinutes = resetsIn;
      }
    }
    if (window.key === "weeklySonnetPct") {
      if (limitsObj) {
        const resetsInHrs = numeric(limitsObj.resets_in_hours);
        if (resetsInHrs !== undefined) {
          usage.weeklySonnetResetsInHours = resetsInHrs;
        }
      }
      const burnRate = (parsed as { burn_rate?: Record<string, unknown> }).burn_rate;
      if (burnRate) {
        const pctPerHour = numeric(burnRate.percent_per_hour);
        if (pctPerHour !== undefined) {
          usage.weeklySonnetBurnPctPerHour = pctPerHour;
        }
      }
      const projection = (parsed as { projection?: Record<string, unknown> }).projection;
      if (projection) {
        const projEndPct = numeric(projection.projected_end_pct);
        if (projEndPct !== undefined) {
          usage.weeklySonnetProjectedEndPct = projEndPct;
        }
        if (typeof projection.hits_100 === "boolean") {
          usage.weeklySonnetHitsLimit = projection.hits_100;
        }
      }
    }
  }

  if (Object.keys(usage).length === 0 && Object.keys(raw).length === 0) {
    return {};
  }
  return { usage, raw };
}

function resolveWorkloadClass(input: unknown): TokenSnapshot["workloadClass"] {
  if (typeof input !== "string") {
    return "unknown";
  }
  if (input.includes("tool")) {
    return "tool-heavy";
  }
  if (input.includes("long")) {
    return "long-context";
  }
  if (input.includes("short")) {
    return "short-context";
  }
  return "unknown";
}

export function extractTokenSnapshot(payload: unknown): TokenSnapshot | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const obj = payload as Record<string, unknown>;
  const model =
    (typeof obj.model === "string" && obj.model) ||
    (typeof obj.model_name === "string" && obj.model_name) ||
    (typeof obj.assistant_model === "string" && obj.assistant_model);
  const tokensIn = numeric(obj.tokens_in) ?? numeric(obj.input_tokens) ?? numeric(obj.prompt_tokens) ?? numeric(obj.inputTokenCount);
  const tokensOut = numeric(obj.tokens_out) ?? numeric(obj.output_tokens) ?? numeric(obj.completion_tokens) ?? numeric(obj.outputTokenCount);
  const tokensCached = numeric(obj.cached_tokens) ?? numeric(obj.cache_read_input_tokens) ?? numeric(obj.cachedInputTokens);
  if (!model || tokensIn === undefined || tokensOut === undefined) {
    return undefined;
  }
  const workloadClass = resolveWorkloadClass(
    obj.workload_class ?? obj.workload ?? obj.classification ?? "unknown",
  );
  return {
    model: model.toLowerCase(),
    tokensIn,
    tokensOut,
    tokensCached,
    workloadClass,
  };
}

export async function readHookPayload(hookFile?: string): Promise<unknown | undefined> {
  if (hookFile) {
    const raw = await readFile(hookFile, "utf8");
    return JSON.parse(raw);
  }
  const envPayload = process.env.CLAUDE_HOOK_PAYLOAD;
  if (!envPayload) {
    return undefined;
  }
  return JSON.parse(envPayload);
}

function extractCcburnSignal(raw: unknown): CcburnSignal | undefined {
  if (!raw) return undefined;
  const session = (raw as Record<string, unknown>).session as Record<string, unknown> | undefined;
  if (!session) return undefined;
  const burnRate = session.burn_rate as Record<string, unknown> | undefined;
  if (!burnRate) return undefined;
  const pctPerHour = numeric(burnRate.percent_per_hour);
  if (pctPerHour === undefined) return undefined;

  const limits = (session.limits as Record<string, Record<string, unknown>> | undefined)?.session;
  const projection = session.projection as Record<string, unknown> | undefined;

  return {
    percentPerHour: pctPerHour,
    trend: typeof burnRate.trend === "string" ? burnRate.trend : "unknown",
    estimatedMinutesTo100: numeric(burnRate.estimated_minutes_to_100) ?? null,
    recommendation: typeof session.recommendation === "string" ? session.recommendation : "unknown",
    sessionResetsInMinutes: numeric(limits?.resets_in_minutes),
    projectedEndPct: numeric(projection?.projected_end_pct),
    hitsLimit: typeof projection?.hits_100 === "boolean" ? projection.hits_100 : undefined,
  };
}

export async function collectSnapshotEvent(
  source: SnapshotSource,
  hookPayload: unknown,
): Promise<SnapshotEvent> {
  const token = extractTokenSnapshot(hookPayload);
  const ccburn = await collectCcburnUsage();
  const accounting = hookPayload ? undefined : await collectCcusageAccounting();
  const ccburnSignal = extractCcburnSignal(ccburn.raw);

  return {
    ts: new Date().toISOString(),
    source,
    token,
    usage: ccburn.usage,
    accounting,
    ccburnSignal,
    usageRaw: ccburn.raw,
  };
}

let resolvedCcusage: string[] | null | undefined;

async function resolveCcusageCmd(): Promise<string[] | null> {
  if (resolvedCcusage !== undefined) return resolvedCcusage;
  const direct = await runCommand("ccusage", ["--version"], 5_000);
  if (direct.ok) {
    resolvedCcusage = ["ccusage"];
    return resolvedCcusage;
  }
  const dlx = await runCommand("pnpm", ["dlx", "ccusage", "--version"], 15_000);
  if (dlx.ok) {
    resolvedCcusage = ["pnpm", "dlx", "ccusage"];
    return resolvedCcusage;
  }
  resolvedCcusage = null;
  return null;
}

async function runCcusageJson(): Promise<unknown | undefined> {
  const cmd = await resolveCcusageCmd();
  if (!cmd) return undefined;
  const offlineArgs = [...cmd.slice(1), "session", "--json", "--offline"];
  const offline = await runCommand(cmd[0], offlineArgs);
  if (offline.ok && offline.stdout.trim()) {
    const parsed = parseJsonFromMixedOutput(offline.stdout);
    if (parsed !== undefined) return parsed;
  }
  const onlineArgs = [...cmd.slice(1), "session", "--json"];
  const online = await runCommand(cmd[0], onlineArgs);
  if (online.ok && online.stdout.trim()) {
    return parseJsonFromMixedOutput(online.stdout);
  }
  return undefined;
}

function aggregateModelTokens(ccusage: unknown, modelKeyword: string): number | undefined {
  if (typeof ccusage !== "object" || ccusage === null) {
    return undefined;
  }
  const sessions = (ccusage as Record<string, unknown>).sessions;
  if (!Array.isArray(sessions)) {
    return undefined;
  }
  let total = 0;
  let found = false;
  for (const session of sessions) {
    if (typeof session !== "object" || session === null) continue;
    const modelBreakdowns = (session as Record<string, unknown>).modelBreakdowns;
    if (!Array.isArray(modelBreakdowns)) continue;
    for (const breakdown of modelBreakdowns) {
      if (typeof breakdown !== "object" || breakdown === null) continue;
      const bd = breakdown as Record<string, unknown>;
      const modelName = String(bd.modelName ?? "").toLowerCase();
      if (!modelName.includes(modelKeyword)) continue;
      const input = numeric(bd.inputTokens) ?? 0;
      const output = numeric(bd.outputTokens) ?? 0;
      const cacheCreation = numeric(bd.cacheCreationTokens) ?? 0;
      const cacheRead = numeric(bd.cacheReadTokens) ?? 0;
      total += input + output + cacheCreation + cacheRead;
      found = true;
    }
  }
  return found ? total : undefined;
}

async function collectCcusageAccounting(): Promise<UsageAccountingSnapshot | undefined> {
  const raw = await runCcusageJson();
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const totals = (raw as Record<string, unknown>).totals as Record<string, unknown> ?? {};
  const totalTokens = numeric(totals.totalTokens);
  const totalCost = numeric(totals.totalCost);
  const sonnetTokens = aggregateModelTokens(raw, "sonnet");
  const opusTokens = aggregateModelTokens(raw, "opus");

  if (totalTokens === undefined && totalCost === undefined && sonnetTokens === undefined && opusTokens === undefined) {
    return undefined;
  }

  return {
    totalTokensCumulative: totalTokens,
    totalCostCumulative: totalCost,
    sonnetTokensCumulative: sonnetTokens,
    opusTokensCumulative: opusTokens,
  };
}
