import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { exists, readText, rootToCwd } from '../fsutil.js';
import type { AgentScan, McpServerConfig, ScanContext, Source } from '../types.js';
import { disp, instructionSources, mcpFromObject, mergeByName, skillSources } from './common.js';

/** Codex truncates the combined project docs at this many bytes by default. */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

export function codexDir(ctx: ScanContext): string {
  const override = ctx.env.CODEX_HOME;
  if (override && path.resolve(ctx.home) === path.resolve(os.homedir())) return override;
  return path.join(ctx.home, '.codex');
}

export function readCodexConfig(file: string): { data: Record<string, unknown> | null; error?: string } {
  const text = readText(file);
  if (text == null) return { data: null };
  try {
    return { data: parseToml(text) as Record<string, unknown> };
  } catch (e) {
    return { data: null, error: (e as Error).message.split('\n')[0] };
  }
}

export function scanCodex(ctx: ScanContext): AgentScan {
  const dir = codexDir(ctx);
  const seen = new Set<string>();
  const sources: Source[] = [];
  const notes: string[] = [];

  const configPath = path.join(dir, 'config.toml');
  const { data: config, error } = readCodexConfig(configPath);
  if (error) notes.push(`Could not parse ${disp(ctx, configPath)}: ${error}`);

  const projectConfigPath = path.join(ctx.repoRoot ?? ctx.cwd, '.codex', 'config.toml');
  const { data: projectConfig } = readCodexConfig(projectConfigPath);

  const fallback = Array.isArray(config?.project_doc_fallback_filenames)
    ? (config.project_doc_fallback_filenames as unknown[]).map(String)
    : [];
  const maxBytes =
    typeof config?.project_doc_max_bytes === 'number' ? config.project_doc_max_bytes : CODEX_PROJECT_DOC_MAX_BYTES;

  // Global: AGENTS.override.md wins over AGENTS.md
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const got = instructionSources(ctx, path.join(dir, name), seen);
    if (got.length) {
      sources.push(...got);
      break;
    }
  }

  // Project: repo root -> cwd, one file per directory.
  let projectBytes = 0;
  for (const d of rootToCwd(ctx.repoRoot, ctx.cwd)) {
    for (const name of ['AGENTS.override.md', 'AGENTS.md', ...fallback]) {
      const got = instructionSources(ctx, path.join(d, name), seen);
      if (got.length) {
        sources.push(...got);
        projectBytes += Buffer.byteLength(got[0]!.text ?? '', 'utf8');
        break;
      }
    }
  }
  if (projectBytes > maxBytes) {
    notes.push(
      `Project AGENTS.md files total ${Math.round(projectBytes / 1024)} KiB; Codex truncates them at ${Math.round(maxBytes / 1024)} KiB (project_doc_max_bytes), so the tail is silently dropped.`,
    );
  }

  // Skills (Codex supports SKILL.md skills with the same progressive disclosure model)
  sources.push(
    ...skillSources(ctx, [path.join(dir, 'skills'), path.join(ctx.repoRoot ?? ctx.cwd, '.codex', 'skills')], seen, notes),
  );

  const mcp: McpServerConfig[] = [];
  mcp.push(...mcpFromObject(config?.mcp_servers, disp(ctx, configPath), 'user', ctx));
  mcp.push(...mcpFromObject(projectConfig?.mcp_servers, disp(ctx, projectConfigPath), 'project', ctx));

  const detected = exists(dir) || sources.length > 0;
  return { id: 'codex', sources, mcp: mergeByName(mcp), notes, detected };
}
