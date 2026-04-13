import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { SnapshotEvent } from "./types.js";

const BASE_DIR =
  process.env.CLAUDE_USAGE_ADVISOR_HOME ?? join(homedir(), ".claude-usage-advisor");
const SNAPSHOT_FILE = join(BASE_DIR, "snapshots.jsonl");
const LOCK_FILE = join(BASE_DIR, "collector.lock");

export function getSnapshotFilePath(): string {
  return SNAPSHOT_FILE;
}

export async function ensureStorage(): Promise<void> {
  await mkdir(BASE_DIR, { recursive: true });
}

export async function appendSnapshot(snapshot: SnapshotEvent): Promise<void> {
  await ensureStorage();
  const line = `${JSON.stringify(snapshot)}\n`;
  await writeFile(SNAPSHOT_FILE, line, { encoding: "utf8", flag: "a" });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(ttlMs = 15 * 60 * 1000): Promise<boolean> {
  await ensureStorage();
  const now = Date.now();
  try {
    const raw = await readFile(LOCK_FILE, "utf8");
    const payload = JSON.parse(raw) as { ts: string; pid?: number };
    const lockTs = new Date(payload.ts).getTime();
    const withinTtl = Number.isFinite(lockTs) && now - lockTs < ttlMs;
    const holderAlive = typeof payload.pid === "number" && isPidAlive(payload.pid);
    if (withinTtl && holderAlive) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // ignore
    }
  }

  await mkdir(dirname(LOCK_FILE), { recursive: true });
  await writeFile(
    LOCK_FILE,
    JSON.stringify({ pid: process.pid, ts: new Date(now).toISOString() }),
    "utf8",
  );
  return true;
}

export async function releaseLock(): Promise<void> {
  try {
    await unlink(LOCK_FILE);
  } catch {
    // ignore
  }
}
