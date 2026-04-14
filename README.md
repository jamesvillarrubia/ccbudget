# ccbudget

CLI-first Claude usage budget advisor and decision engine. It classifies budget failure modes, ranks capability-preserving fallback paths across Opus, Sonnet, and Haiku, and emits structured JSON for tooling.

## Requirements

- Node.js 22+ for source builds and npm installs
- macOS only: Xcode command line tools for `codesign` when building SEA binaries locally

## Quick Start

```bash
npx ccbudget advisor now --json
```

## Install

### npm / pnpm

```bash
pnpm add -g ccbudget
# or
npm install -g ccbudget

ccbudget advisor now
ccbudget advisor now --json
```

### GitHub Releases binary

1. Open [github.com/jamesvillarrubia/ccbudget/releases/latest](https://github.com/jamesvillarrubia/ccbudget/releases/latest).
2. Download the asset matching your platform, for example `ccbudget-darwin-arm64`, `ccbudget-linux-x64`, or `ccbudget-win32-x64.exe`.
3. Rename it to `ccbudget` if you want, mark it executable on Unix (`chmod +x ccbudget`), and move it somewhere on your `PATH`.
4. Run `ccbudget advisor now --json`.

The release binaries are built with Node's [single executable application](https://nodejs.org/api/single-executable-applications.html) workflow.

## Claude Code `/budget`

Install the personal slash-command template:

```bash
mkdir -p ~/.claude/commands
curl -fsSL "https://raw.githubusercontent.com/jamesvillarrubia/ccbudget/main/integrations/claude/commands/budget.md" \
  -o ~/.claude/commands/budget.md
```

Then run `/budget` inside Claude Code. The template shells out to `ccbudget advisor now`, so make sure `ccbudget` is already on your `PATH`.

## Build from source

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm release:smoke
```

## Build a standalone binary locally

```bash
pnpm build
pnpm build:sea
pnpm release:smoke:sea
```

The local binary is written to `release/ccbudget` (`release\ccbudget.exe` on Windows).

## Publish checklist

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm release:smoke
pnpm build:sea
pnpm release:smoke:sea
pnpm pack:dry-run
```

Tagging `v*` pushes triggers the GitHub release workflow in `.github/workflows/release.yml`.

## Configuration

Spend policy is read from environment variables. The current knobs live in `src/config.ts`, and the decision-policy rationale lives in `docs/superpowers/specs/2026-04-12-ccbudget-decision-engine-design.md`.
