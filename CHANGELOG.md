# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-02

### Added

- First release.
- Discovery for Claude Code (CLAUDE.md hierarchy, `@` imports, skills, subagents, slash commands, MCP from `~/.claude.json` and `.mcp.json`),
  Codex CLI (AGENTS.md hierarchy and overrides, skills, `config.toml` MCP servers),
  Gemini CLI (GEMINI.md hierarchy, imports, extensions, `settings.json` MCP servers),
  Cursor (`.cursorrules`, `.cursor/rules` with `alwaysApply`, skills, `mcp.json`) and
  VS Code / Copilot (`copilot-instructions.md`, path instructions, `.vscode/mcp.json`).
- MCP measurement over stdio, Streamable HTTP and SSE with pagination, timeouts, concurrency limit,
  cross-agent de-duplication and guaranteed process cleanup.
- Token counting with `o200k_base` (js-tiktoken).
- Pretty terminal report, `--json` (schemaVersion 1, JSON Schema included) and `--markdown` output.
- Suggestions: heavy MCP servers, large instruction files, duplicated content, long skill descriptions, full context window.
- `--max-tokens` budget gate for CI (exit code 1), usage errors exit with code 2.

[0.1.0]: https://github.com/paulochastinet/context-diet/releases/tag/v0.1.0
