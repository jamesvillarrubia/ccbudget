import { execFile } from "node:child_process";

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function runCommand(command: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? error.message),
          exitCode: typeof (error as { code?: number }).code === "number" ? (error as { code: number }).code : 1,
        });
        return;
      }

      resolve({
        ok: true,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        exitCode: 0,
      });
    });
  });
}
