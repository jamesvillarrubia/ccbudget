import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CcburnSignal, PricingBaseline, PricingHistoryEntry, SnapshotEvent, SnapshotSource, UsageAccountingSnapshot, WindowUsageSnapshot } from "./types.js";
import { isPeakHour } from "./pricing.js";
import { ensureStorage } from "./storage.js";

const BASE_DIR =
  process.env.CLAUDE_USAGE_ADVISOR_HOME ?? join(homedir(), ".claude-usage-advisor");
const STATE_FILE = join(BASE_DIR, "rolling-state.json");
const PRICING_HISTORY_FILE = join(BASE_DIR, "pricing-history.jsonl");
const DEFAULT_RETENTION_MINUTES = 360;
const PRICING_HISTORY_MAX_AGE_DAYS = 7;

interface MinuteBucket {
  minuteTs: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  usage?: WindowUsageSnapshot;
  accounting?: UsageAccountingSnapshot;
  ccburnSignal?: CcburnSignal;
  source?: SnapshotSource;
  sampleCount: number;
}

interface RollingState {
  version: 1;
  lastSnapshotTs?: string;
  buckets: MinuteBucket[];
}

function floorToMinuteIso(date: Date): string {
  const floored = new Date(date);
  floored.setSeconds(0, 0);
  return floored.toISOString();
}

function sanitizeState(input: unknown): RollingState {
  if (typeof input !== "object" || input === null) {
    return { version: 1, buckets: [] };
  }
  const maybe = input as Partial<RollingState>;
  if (!Array.isArray(maybe.buckets)) {
    return { version: 1, buckets: [] };
  }
  return {
    version: 1,
    lastSnapshotTs: typeof maybe.lastSnapshotTs === "string" ? maybe.lastSnapshotTs : undefined,
    buckets: maybe.buckets
      .filter((bucket): bucket is MinuteBucket => typeof bucket?.minuteTs === "string")
      .map((bucket) => ({
        minuteTs: bucket.minuteTs,
        tokensIn: Number(bucket.tokensIn ?? 0),
        tokensOut: Number(bucket.tokensOut ?? 0),
        tokensCached: Number(bucket.tokensCached ?? 0),
        usage: bucket.usage,
        accounting: bucket.accounting,
        ccburnSignal: bucket.ccburnSignal,
        source: bucket.source,
        sampleCount: Number(bucket.sampleCount ?? 0),
      })),
  };
}

async function readState(): Promise<RollingState> {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    return sanitizeState(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, buckets: [] };
    }
    throw error;
  }
}

async function writeState(state: RollingState): Promise<void> {
  await ensureStorage();
  await writeFile(STATE_FILE, JSON.stringify(state), "utf8");
}

function mergeUsage(existing: WindowUsageSnapshot | undefined, incoming: WindowUsageSnapshot | undefined) {
  if (!incoming) return existing;
  return {
    sessionPct: incoming.sessionPct ?? existing?.sessionPct,
    weeklyPct: incoming.weeklyPct ?? existing?.weeklyPct,
    weeklySonnetPct: incoming.weeklySonnetPct ?? existing?.weeklySonnetPct,
    sessionResetsInMinutes: incoming.sessionResetsInMinutes ?? existing?.sessionResetsInMinutes,
    weeklySonnetResetsInHours: incoming.weeklySonnetResetsInHours ?? existing?.weeklySonnetResetsInHours,
    weeklySonnetBurnPctPerHour: incoming.weeklySonnetBurnPctPerHour ?? existing?.weeklySonnetBurnPctPerHour,
    weeklySonnetProjectedEndPct: incoming.weeklySonnetProjectedEndPct ?? existing?.weeklySonnetProjectedEndPct,
    weeklySonnetHitsLimit: incoming.weeklySonnetHitsLimit ?? existing?.weeklySonnetHitsLimit,
  };
}

function pruneBuckets(buckets: MinuteBucket[], now: Date, retentionMinutes: number): MinuteBucket[] {
  const cutoff = now.getTime() - retentionMinutes * 60_000;
  return buckets.filter((bucket) => new Date(bucket.minuteTs).getTime() >= cutoff);
}

export async function updateRollingStateWithSnapshot(snapshot: SnapshotEvent): Promise<void> {
  const state = await readState();
  const retentionMinutes = Number(process.env.CLAUDE_ADVISOR_RETENTION_MINUTES ?? DEFAULT_RETENTION_MINUTES);
  const minuteTs = floorToMinuteIso(new Date(snapshot.ts));

  const buckets = [...state.buckets];
  let bucket = buckets.find((item) => item.minuteTs === minuteTs);
  if (!bucket) {
    bucket = {
      minuteTs,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      sampleCount: 0,
    };
    buckets.push(bucket);
  }

  if (snapshot.token) {
    bucket.tokensIn += snapshot.token.tokensIn;
    bucket.tokensOut += snapshot.token.tokensOut;
    bucket.tokensCached += snapshot.token.tokensCached ?? 0;
  }
  bucket.usage = mergeUsage(bucket.usage, snapshot.usage);
  if (snapshot.accounting) {
    bucket.accounting = snapshot.accounting;
  }
  if (snapshot.ccburnSignal) {
    bucket.ccburnSignal = snapshot.ccburnSignal;
  }
  bucket.source = snapshot.source;
  bucket.sampleCount += 1;

  buckets.sort((a, b) => new Date(a.minuteTs).getTime() - new Date(b.minuteTs).getTime());
  const pruned = pruneBuckets(buckets, new Date(snapshot.ts), retentionMinutes);

  await writeState({
    version: 1,
    lastSnapshotTs: snapshot.ts,
    buckets: pruned,
  });
}

export async function getLatestSnapshotTsFast(): Promise<Date | null> {
  const state = await readState();
  if (!state.lastSnapshotTs) {
    return null;
  }
  const parsed = new Date(state.lastSnapshotTs);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export async function readRecentSnapshotsFromState(minutes: number): Promise<SnapshotEvent[]> {
  const state = await readState();
  const now = Date.now();
  const cutoff = now - minutes * 60_000;

  return state.buckets
    .filter((bucket) => new Date(bucket.minuteTs).getTime() >= cutoff)
    .map((bucket): SnapshotEvent => ({
      ts: bucket.minuteTs,
      source: bucket.source ?? "manual",
      token:
        bucket.tokensIn + bucket.tokensOut + bucket.tokensCached > 0
          ? {
              model: "mixed",
              tokensIn: bucket.tokensIn,
              tokensOut: bucket.tokensOut,
              tokensCached: bucket.tokensCached,
              workloadClass: "unknown",
            }
          : undefined,
      usage: bucket.usage,
      accounting: bucket.accounting,
      ccburnSignal: bucket.ccburnSignal,
    }));
}

export async function appendPricingHistory(entry: PricingHistoryEntry): Promise<void> {
  await ensureStorage();
  await appendFile(PRICING_HISTORY_FILE, JSON.stringify(entry) + "\n", "utf8");
}

const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const HALF_LIFE_DAYS = 2;

function parseAllEntries(raw: string, cutoffMs: number): PricingHistoryEntry[] {
  const entries: PricingHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as PricingHistoryEntry;
      const tsMs = new Date(entry.ts).getTime();
      if (tsMs >= cutoffMs && entry.tokensPerPct > 0 && entry.burnPctPerHour > 0) {
        entries.push(entry);
      }
    } catch {
      // skip malformed
    }
  }
  return entries;
}

function backfillEntry(e: PricingHistoryEntry): PricingHistoryEntry {
  if (e.opusNormalizedTpp == null || e.opusNormalizedTpp <= 0) {
    e.opusNormalizedTpp = e.tokensPerPct;
  }
  if (e.isPeak == null) {
    e.isPeak = isPeakHour(new Date(e.ts));
  }
  return e;
}

function dedup(entries: PricingHistoryEntry[]): PricingHistoryEntry[] {
  if (entries.length <= 1) return entries;
  const sorted = [...entries].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  const result: PricingHistoryEntry[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(result[result.length - 1].ts).getTime();
    const curr = new Date(sorted[i].ts).getTime();
    if (curr - prev < DEDUP_WINDOW_MS) {
      result[result.length - 1] = sorted[i];
    } else {
      result.push(sorted[i]);
    }
  }
  return result;
}

function weightedAvg(
  entries: PricingHistoryEntry[],
  field: (e: PricingHistoryEntry) => number,
  nowMs: number,
): number {
  const lambda = Math.LN2 / (HALF_LIFE_DAYS * 24 * 60 * 60 * 1000);
  let sumWeighted = 0;
  let sumWeights = 0;
  for (const e of entries) {
    const ageMs = nowMs - new Date(e.ts).getTime();
    const w = Math.exp(-lambda * ageMs);
    sumWeighted += field(e) * w;
    sumWeights += w;
  }
  return sumWeights > 0 ? sumWeighted / sumWeights : 0;
}

export async function readPricingBaseline(forPeak?: boolean): Promise<PricingBaseline | null> {
  let raw: string;
  try {
    raw = await readFile(PRICING_HISTORY_FILE, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const cutoff = Date.now() - PRICING_HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const currentlyPeak = forPeak ?? isPeakHour(new Date());

  let all = parseAllEntries(raw, cutoff).map(backfillEntry);
  all = dedup(all);

  let matched = all.filter((e) => e.isPeak === currentlyPeak);

  if (matched.length < 3) {
    matched = all;
  }

  if (matched.length === 0) return null;

  return {
    avgTokensPerPct: weightedAvg(matched, (e) => e.opusNormalizedTpp, nowMs),
    avgBurnPctPerHour: weightedAvg(matched, (e) => e.burnPctPerHour, nowMs),
    sampleCount: matched.length,
    isPeak: currentlyPeak,
  };
}
