# Contributing to context-diet

Thanks for helping put coding agents on a diet!

## Setup

```bash
git clone https://github.com/paulochastinet/context-diet
cd context-diet
npm install        # also builds dist/ via the `prepare` script
npm run typecheck
npm test
node dist/cli.js --verbose
```

Requires Node.js >= 18.18.

## Project layout

```
src/
  cli.ts              entry point (argument handling, exit codes)
  args.ts             option parsing (node:util parseArgs)
  profile.ts          orchestration: scan agents -> measure MCP -> build report
  agents/             one scanner per agent (claude, codex, gemini, cursor, vscode) + shared helpers
  mcp.ts              MCP client: launch/connect, tools/list, timeouts, cleanup
  suggestions.ts      rules that turn a report into advice
  render/             pretty (terminal) and markdown renderers
  tokens.ts           o200k_base token counting
schema/report.schema.json   JSON output contract (schemaVersion 1)
test/                 vitest suites; fixtures/ holds a fake home + project and tiny MCP servers
```

## Guidelines

- Keep dependencies minimal; prefer `node:` built-ins.
- Every new discovery rule needs a fixture under `test/fixtures/` and a test in `test/agents.test.ts`.
  The fixture project's `.git` directory is stored as `_git` and renamed when copied into a temp sandbox.
- Changes to the JSON output must keep `schema/report.schema.json` in sync. Breaking changes bump `schemaVersion`.
- Never crash on a malformed config file or a misbehaving MCP server: report it and move on.
- Run `npm run typecheck && npm test` before opening a PR.

## Adding an agent

1. Add the id to `AgentId` / `AGENT_IDS` / `AGENT_NAMES` in `src/types.ts`.
2. Create `src/agents/<id>.ts` returning an `AgentScan` (sources + MCP configs + notes).
3. Register it in `SCANNERS` (`src/profile.ts`) and add a hint to `MCP_HINT` (`src/suggestions.ts`).
4. Add fixtures, tests, and a column in the README's support matrix.

## Releasing

Update `CHANGELOG.md`, bump the version in `package.json`, tag `vX.Y.Z`, then `npm publish`.
