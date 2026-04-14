import { access, cp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const outDir = join(root, "release");
const seaDir = join(root, ".sea");
const distCli = join(root, "dist", "cli.js");
const seaConfig = join(root, "sea-config.json");
const postjectCli = join(root, "node_modules", "postject", "dist", "cli.js");
const tsupCli = join(root, "node_modules", "tsup", "dist", "cli-default.js");

function runNode(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd: root, stdio: "inherit", ...opts }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: root, stdio: "inherit", ...opts }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

try {
  await access(distCli);
} catch {
  console.error("Missing dist/cli.js — run `pnpm build` first.");
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await rm(seaDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await mkdir(seaDir, { recursive: true });

await runNode([
  tsupCli,
  "src/cli.ts",
  "--out-dir",
  ".sea",
  "--format",
  "cjs",
  "--target",
  "node22",
  "--clean",
  "--no-config",
  "--silent",
]);

await runNode(["--experimental-sea-config", seaConfig]);

const isWin = process.platform === "win32";
const target = join(outDir, isWin ? "ccbudget.exe" : "ccbudget");
await cp(process.execPath, target);

if (process.platform === "darwin") {
  await runCmd("codesign", ["--remove-signature", target]).catch(() => {});
}

const blobPath = join(seaDir, "ccbudget.blob");
const postjectArgs = [
  postjectCli,
  target,
  "NODE_SEA_BLOB",
  blobPath,
  "--sentinel-fuse",
  "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
];
if (process.platform === "darwin") {
  postjectArgs.push("--macho-segment-name", "NODE_SEA");
}

await runNode(postjectArgs);

if (process.platform === "darwin") {
  await runCmd("codesign", ["--sign", "-", "--force", "--timestamp=none", target]);
}
