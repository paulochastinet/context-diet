import os from 'node:os';
import path from 'node:path';
import { ancestors, exists, listDir, readJson } from '../fsutil.js';
import type { AgentScan, McpServerConfig, ScanContext, Source } from '../types.js';
import {
  describedMarkdownSources,
  disp,
  instructionSources,
  mcpFromObject,
  mergeByName,
  skillSources,
} from './common.js';

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

export function claudeDir(ctx: ScanContext): string {
  const override = ctx.env.CLAUDE_CONFIG_DIR;
  if (override && path.resolve(ctx.home) === path.resolve(os.homedir())) return override;
  return path.join(ctx.home, '.claude');
}

export function scanClaude(ctx: ScanContext): AgentScan {
  const dir = claudeDir(ctx);
  const seen = new Set<string>();
  const sources: Source[] = [];
  const notes: string[] = [];

  // 1. User memory
  sources.push(...instructionSources(ctx, path.join(dir, 'CLAUDE.md'), seen, { withImports: true }));

  // 2. Project memory: every ancestor from the top down to cwd.
  const dirs = ancestors(ctx.cwd, ctx.ceiling).reverse();
  for (const d of dirs) {
    for (const name of ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      sources.push(...instructionSources(ctx, path.join(d, name), seen, { withImports: true }));
    }
  }

  // 3. Skills / subagents / commands (user + project)
  const projectDirs = [...new Set([ctx.cwd, ctx.repoRoot].filter((x): x is string => !!x))];
  const proj = (sub: string) => projectDirs.map((p) => path.join(p, '.claude', sub));
  sources.push(...skillSources(ctx, [path.join(dir, 'skills'), ...proj('skills')], seen, notes));
  sources.push(
    ...describedMarkdownSources(ctx, [path.join(dir, 'agents'), ...proj('agents')], 'subagent', seen, {
      recursive: true,
    }),
  );
  sources.push(
    ...describedMarkdownSources(ctx, [path.join(dir, 'commands'), ...proj('commands')], 'command', seen, {
      recursive: true,
      prefix: '/',
    }),
  );

  // 4. MCP servers: user (~/.claude.json mcpServers) < project (.mcp.json) < local (projects[cwd])
  const mcp: McpServerConfig[] = [];
  const claudeJsonPath = path.join(path.dirname(dir) === ctx.home ? ctx.home : dir, '.claude.json');
  const claudeJson = obj(readJson(claudeJsonPath));
  const disabled = new Set<string>();
  if (claudeJson) {
    mcp.push(...mcpFromObject(claudeJson.mcpServers, disp(ctx, claudeJsonPath), 'user', ctx));
  }
  for (const p of projectDirs) {
    const mcpJson = path.join(p, '.mcp.json');
    const data = obj(readJson(mcpJson));
    if (data) mcp.push(...mcpFromObject(data.mcpServers, disp(ctx, mcpJson), 'project', ctx));
  }
  const projects = obj(claudeJson?.projects);
  for (const p of projectDirs) {
    const entry = obj(projects?.[p]);
    if (!entry) continue;
    mcp.push(...mcpFromObject(entry.mcpServers, `${disp(ctx, claudeJsonPath)} (project ${disp(ctx, p)})`, 'local', ctx));
    for (const n of strArray(entry.disabledMcpjsonServers)) disabled.add(n);
    for (const n of strArray(entry.disabledMcpServers)) disabled.add(n);
  }
  const settingsFiles = [
    path.join(dir, 'settings.json'),
    ...proj('settings.json'),
    ...proj('settings.local.json'),
  ];
  const enabledPlugins = new Set<string>();
  for (const f of settingsFiles) {
    const s = obj(readJson(f));
    if (!s) continue;
    for (const n of strArray(s.disabledMcpjsonServers)) disabled.add(n);
    const plugins = obj(s.enabledPlugins);
    if (plugins) for (const [k, v] of Object.entries(plugins)) if (v) enabledPlugins.add(k);
  }
  const merged = mergeByName(mcp).map((s) => (disabled.has(s.name) ? { ...s, disabled: true } : s));

  if (enabledPlugins.size) {
    const names = [...enabledPlugins].map((p) => p.split('@')[0]).join(', ');
    notes.push(
      `${enabledPlugins.size} plugin(s) enabled (${names}); plugin skills, agents and MCP servers are not profiled yet.`,
    );
  }
  if (claudeJson?.claudeAiMcpEverConnected) {
    notes.push('claude.ai connectors (remote MCP managed by your Anthropic account) are not visible locally and not counted.');
  }

  const detected =
    exists(dir) || !!claudeJson || sources.length > 0 || merged.length > 0 || listDir(path.join(ctx.cwd, '.claude')).length > 0;

  return { id: 'claude', sources, mcp: merged, notes, detected };
}
