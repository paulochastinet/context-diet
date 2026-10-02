<h1 align="center">context-diet</h1>

<p align="center"><b>See what your AI coding agent eats before you type a word.</b></p>

<p align="center">
  <a href="https://github.com/paulochastinet/context-diet/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/paulochastinet/context-diet/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/context-diet"><img alt="npm" src="https://img.shields.io/npm/v/context-diet.svg"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
  <img alt="Node >= 18.18" src="https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg">
</p>

`context-diet` profiles the **always-loaded context** (the "context tax") of your coding agents:
**Claude Code, OpenAI Codex CLI, Gemini CLI, Cursor and VS Code / Copilot**. It finds every
instruction file, `@import`, skill, subagent, slash command and **MCP server tool schema** that
is sent with every request, counts the tokens, ranks the worst offenders and tells you how to fix them.
Zero config, one command, with a CI budget gate.

```console
$ npx context-diet
Starting 3 configured MCP servers locally to read their tool lists (--no-mcp to skip)…


  context-diet v0.1.0  what your agents eat before you type a word
  ~/code  ·  window 200k  ·  ≈tokens (o200k_base)

  Claude Code            ≈3.9k tok  ▏░░░░░░░░░░░░░░░░░░░  2% of 200k
  ────────────────────────────────────────────────────────────────────────────────────────────────
  subagents     7 subagents (descriptions)         +5.2k on demand          2.5k  ████████████████
  skills        10 skills (descriptions)           +31k on demand           1.5k  █████████▍
  mcp           linear                             ✗ needs auth                —
  mcp           notion                             ✗ needs auth                —
  ℹ 9 skill(s) with a duplicate name were ignored (first one found wins).
  ℹ 1 plugin(s) enabled (vercel); plugin skills, agents and MCP servers are not profiled yet.
  ℹ claude.ai connectors (remote MCP managed by your Anthropic account) are not visible locally and not counted.
  ℹ 2 MCP server(s) could not be measured; the total is a lower bound.

  Cursor                 ≈6.8k tok  █░░░░░░░░░░░░░░░░░░░  3.4% of 200k
  ────────────────────────────────────────────────────────────────────────────────────────────────
  mcp           railway                            34 tools                 6.7k  ████████████████
  skills        1 skill (descriptions)             +2.8k on demand            97  ▎
  ℹ User Rules from Cursor Settings are stored in the app, not on disk, and are not counted.

  Not detected: Codex CLI, Gemini CLI, VS Code / Copilot

  Suggestions
  ●  5 skill descriptions are over 150 tokens and always loaded in Claude Code: docs (241), pptx
     (218), docx (212) and 2 more. One or two sentences on *when* to use a skill are enough.
  ●  2 remote MCP server(s) need authentication that only the agent holds (linear, notion), so
     their tools are not counted. Totals are a lower bound.
```

<sub>Sample output (paths and server names shortened). Add <code>--verbose</code> to expand every skill and the five heaviest tools of each MCP server.</sub>

## Why

Before you type anything, your agent has already loaded `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`,
everything they `@import`, the description of every skill and subagent, and the full JSON schema
of **every tool of every MCP server** you have configured. That cost is paid on every request, it
eats into the context window, and it is mostly invisible:

- People keep hitting limits and asking where their context went
  ([anthropics/claude-code#16157](https://github.com/anthropics/claude-code/issues/16157),
  [#38335](https://github.com/anthropics/claude-code/issues/38335),
  [#46917](https://github.com/anthropics/claude-code/issues/46917)).
- A single popular MCP server (GitHub's) has been measured at roughly **55k tokens** of tool definitions.
- Each agent has its own files, its own MCP config format and its own loading rules, so nobody has the full picture.

`context-diet` gives you that picture across all your agents at once, and lets you put a budget on it in CI.

## Quickstart

```bash
npx context-diet                        # profile the current project + your user config
npx context-diet --verbose              # expand skills and the heaviest MCP tools
npx context-diet --agent claude,codex   # only some agents
npx context-diet --no-mcp               # don't start MCP servers, files only
```

Straight from GitHub (no npm publish needed):

```bash
npx github:paulochastinet/context-diet
```

> **Heads-up:** to count MCP tool schemas, `context-diet` starts each configured MCP server locally
> (exactly like your agent does), calls `tools/list`, and shuts it down. It prints a one-line notice
> before doing so. Use `--no-mcp` to skip this entirely.

## Options

| Option | Default | Description |
|---|---|---|
| `-a, --agent <list>` | all | Comma-separated: `claude`, `codex`, `gemini`, `cursor`, `vscode` (repeatable) |
| `--cwd <dir>` | `.` | Project directory to profile |
| `--home <dir>` | `~` | Home directory to read user-level config from |
| `-w, --window <n>` | `200k` | Context window used for the "% of window" figure |
| `--max-tokens <n>` | — | Budget. Exit code `1` if any selected agent exceeds it |
| `--timeout <ms>` | `20000` | Per-MCP-server timeout |
| `--concurrency <n>` | `4` | MCP servers measured in parallel |
| `--no-mcp` | — | Don't launch MCP servers |
| `--json` | — | Machine-readable output ([schema](./schema/report.schema.json)) |
| `-m, --markdown` | — | Markdown output (PR comments, `$GITHUB_STEP_SUMMARY`) |
| `-v, --verbose` | — | Expand skills / subagents / commands and the top 5 tools per MCP server |
| `--no-color` | — | Disable colors (`NO_COLOR` and non-TTY output are respected automatically) |
| `-V, --version` / `-h, --help` | | |

Numbers accept `k` / `m` suffixes (`--max-tokens 40k`).
**Exit codes:** `0` OK · `1` over budget · `2` usage error.

## CI: put your agents on a diet

Fail the build when the always-loaded context grows past a budget, and get a report in the job summary:

```yaml
# .github/workflows/context-diet.yml
name: context-diet
on: [pull_request]

jobs:
  context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Context budget
        run: |
          npx -y context-diet --no-mcp --markdown --max-tokens 20000 >> "$GITHUB_STEP_SUMMARY"
```

In CI there is usually no user-level config (`~/.claude`, `~/.codex`, …), so the report covers the
files committed to the repository: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursor/rules`,
`.github/copilot-instructions.md`, project skills and `.mcp.json` / `.vscode/mcp.json` servers.
Drop `--no-mcp` if your project MCP servers can start in CI and you want their schemas counted too.
Because `--markdown` goes to stdout and the budget message to stderr, the summary is written even when the step fails.

## What is counted

| | Claude Code | Codex CLI | Gemini CLI | Cursor | VS Code / Copilot |
|---|:-:|:-:|:-:|:-:|:-:|
| User instructions | `~/.claude/CLAUDE.md` | `~/.codex/AGENTS.md` (`AGENTS.override.md`) | `~/.gemini/GEMINI.md` | (app settings, not on disk) | — |
| Project instructions | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` from cwd up to `/` | `AGENTS.md` from repo root down to cwd | `GEMINI.md` up to repo root + subdirectories (respects `context.fileName`) | `.cursorrules`, `.cursor/rules/**/*.mdc` | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` |
| `@path` imports | ✓ (recursive, depth 5, cycle-safe) | — | ✓ | — | — |
| Skills (name + description) | `~/.claude/skills`, `.claude/skills` | `~/.codex/skills`, `.codex/skills` | — | `~/.cursor/skills`, `.cursor/skills` | — |
| Subagents / commands | `.claude/agents`, `.claude/commands` (+ user dirs) | — | — | — | — |
| MCP servers | `~/.claude.json` (user + per-project), `.mcp.json` | `~/.codex/config.toml`, `.codex/config.toml` | `settings.json` (user + project), extensions | `~/.cursor/mcp.json`, `.cursor/mcp.json` | `.vscode/mcp.json`, user `mcp.json` |
| Disabled servers honoured | `disabledMcpjsonServers`, `disabledMcpServers` | `enabled = false` | `mcp.excluded` | `disabled: true` | `disabled: true` |

- **Conditional** sources (Cursor rules with `globs` or no `alwaysApply`, Copilot `applyTo` instructions)
  are shown but **not** added to the total. For "agent-requested" Cursor rules, the description is counted.
- **Skills** use progressive disclosure: only `name` + `description` are always loaded; the body is shown as "on demand".
- An MCP server configured identically in several agents is started **once** and attributed to all of them.
- Environment placeholders such as `${VAR}`, `${VAR:-default}`, `${env:VAR}`, `${workspaceFolder}` and `${userHome}`
  are expanded. Servers needing VS Code `${input:…}` prompts are reported, not started.
- Codex: a note is printed when project `AGENTS.md` files exceed `project_doc_max_bytes` (32 KiB), since Codex silently truncates them.

## How tokens are counted (and limitations)

- Tokens are counted with OpenAI's **`o200k_base`** BPE ([js-tiktoken](https://github.com/dqbd/tiktoken), pure JS, offline).
  Claude and Gemini use their own tokenizers, so treat every number as an **approximation** (≈, typically within 10–20%).
  The point is the ranking and the order of magnitude.
- **MCP tools** are counted as the JSON `{"name", "description", "input_schema"}` of each tool, which is close to what clients
  send to the model. Prompts count `name + description`. Resources are listed for information but **not** counted, since they are not
  loaded into context by default.
- The agents' own system prompts and built-in tools are **not** included: they're fixed costs you can't change.
- Remote MCP servers that need OAuth (or a token only the agent holds) show up as `needs auth` and count as 0. The total is then a lower bound.
- Not profiled yet: Claude Code plugins (noted when enabled), claude.ai connectors, Cursor user rules stored in the app,
  enterprise/managed policy files.

## JSON output

`--json` prints a stable document (`schemaVersion: 1`) described by [`schema/report.schema.json`](./schema/report.schema.json) (example values):

```jsonc
{
  "schemaVersion": 1,
  "tool": { "name": "context-diet", "version": "0.1.0" },
  "generatedAt": "2026-10-02T14:00:00.000Z",
  "cwd": "/home/me/app", "home": "/home/me",
  "tokenizer": "o200k_base", "window": 200000, "mcpMeasured": true,
  "agents": [{
    "id": "claude", "name": "Claude Code", "detected": true,
    "totalTokens": 12840, "conditionalTokens": 0, "onDemandTokens": 31022,
    "windowPercent": 6.4, "overBudget": false,
    "sources": [
      { "kind": "mcp", "name": "github", "tokens": 9120, "loading": "always", "serverKey": "3f2a…", "displayPath": "~/.claude.json" },
      { "kind": "instructions", "name": "CLAUDE.md", "path": "/home/me/app/CLAUDE.md", "displayPath": "CLAUDE.md", "tokens": 2210, "loading": "always", "depth": 0 },
      { "kind": "import", "name": "style.md", "displayPath": "docs/style.md", "parent": "CLAUDE.md", "depth": 1, "tokens": 640, "loading": "always" },
      { "kind": "skill", "name": "pdf", "tokens": 21, "onDemandTokens": 1830, "loading": "always" }
    ],
    "notes": []
  }],
  "mcpServers": [{
    "key": "3f2a…", "name": "github", "transport": "stdio", "target": "npx -y @modelcontextprotocol/server-github",
    "status": "ok", "tokens": 9120, "toolTokens": 9120, "promptTokens": 0, "resourceTokens": 0,
    "toolCount": 26, "promptCount": 0, "resourceCount": 0,
    "tools": [{ "name": "create_pull_request", "tokens": 610 }],
    "durationMs": 1840, "usedBy": ["claude", "codex"]
  }],
  "suggestions": [{ "id": "mcp-heavy", "severity": "medium", "agent": "claude", "target": "github", "tokens": 9120, "message": "…" }],
  "budget": { "maxTokens": null, "exceeded": [] }
}
```

`status` is one of `ok`, `error`, `timeout`, `auth`, `skipped` (`--no-mcp`), `disabled`. Suggestion ids:
`context-heavy`, `mcp-heavy`, `instructions-large`, `duplicate-instructions`, `duplicate-across-agents`,
`skill-description-long`, `skills-many`, `mcp-unmeasured`, `mcp-auth`.

You can also use it as a library:

```ts
import { profile } from 'context-diet';
const report = await profile({ cwd: process.cwd(), home: os.homedir(), mcp: false });
```

## FAQ

**Is it safe to run? It starts my MCP servers.**
It starts them exactly the way your agent would (same command, args and env), only performs the
`initialize` + `tools/list` / `prompts/list` / `resources/list` handshake, and then closes stdin and
terminates the process (SIGTERM, then SIGKILL). No tool is ever called. Use `--no-mcp` if you'd rather not.

**Why are the numbers different from `/context` in Claude Code?**
Different tokenizer (≈), plus Claude Code adds its system prompt and built-in tools, and may defer MCP
tools behind tool search. `context-diet` measures what *you* control.

**An MCP server shows `timeout`.**
Servers launched through `npx`/`uvx` may download packages on first start. Re-run with `--timeout 60000`.

**Does it send anything anywhere?**
No. Everything runs locally; the only network traffic is what your remote (HTTP/SSE) MCP servers need for `tools/list`.

**Windows?**
It should work (paths are handled with `node:path`), but CI only covers Linux and macOS for now. Reports welcome.

## Contributing

Issues and PRs are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md). Adding a new agent is usually one file in
`src/agents/` plus fixtures in `test/fixtures/`.

## License

[MIT](./LICENSE) © 2026 Paulo Chastinet
