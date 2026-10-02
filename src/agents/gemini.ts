import path from 'node:path';
import { ancestors, direntIsDir, exists, listDir, readJson, rootToCwd } from '../fsutil.js';
import type { AgentScan, McpServerConfig, ScanContext, Source } from '../types.js';
import { disp, instructionSources, mcpFromObject, mergeByName } from './common.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__']);
const MAX_SCAN_DIRS = 200;

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function contextFileNames(settings: Record<string, unknown>[]): string[] {
  let names: string[] = ['GEMINI.md'];
  for (const s of settings) {
    const ctxObj = obj(s.context);
    const v = ctxObj?.fileName ?? s.contextFileName;
    if (typeof v === 'string') names = [v];
    else if (Array.isArray(v) && v.length) names = v.map(String);
  }
  return names;
}

/** Breadth-first scan below cwd (Gemini CLI also loads context files from subdirectories). */
function descendants(root: string): string[] {
  const out: string[] = [];
  const queue = [root];
  while (queue.length && out.length < MAX_SCAN_DIRS) {
    const d = queue.shift()!;
    if (d !== root) out.push(d);
    for (const e of listDir(d)) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      if (direntIsDir(d, e)) queue.push(path.join(d, e.name));
    }
  }
  return out;
}

export function scanGemini(ctx: ScanContext): AgentScan {
  const dir = path.join(ctx.home, '.gemini');
  const seen = new Set<string>();
  const sources: Source[] = [];
  const notes: string[] = [];

  const userSettingsPath = path.join(dir, 'settings.json');
  const projectSettingsPath = path.join(ctx.repoRoot ?? ctx.cwd, '.gemini', 'settings.json');
  const userSettings = obj(readJson(userSettingsPath));
  const projectSettings = obj(
    readJson(exists(path.join(ctx.cwd, '.gemini', 'settings.json')) ? path.join(ctx.cwd, '.gemini', 'settings.json') : projectSettingsPath),
  );
  const names = contextFileNames([userSettings, projectSettings].filter((x): x is Record<string, unknown> => !!x));

  for (const name of names) {
    sources.push(...instructionSources(ctx, path.join(dir, name), seen, { withImports: true }));
  }
  // Upward: from project root (or cwd) to cwd. Without a repo, Gemini walks up to home.
  const upward = ctx.repoRoot
    ? rootToCwd(ctx.repoRoot, ctx.cwd)
    : ancestors(ctx.cwd, ctx.ceiling ?? ctx.home).reverse();
  for (const d of upward) {
    for (const name of names) {
      sources.push(...instructionSources(ctx, path.join(d, name), seen, { withImports: true }));
    }
  }
  // Only scan below cwd if Gemini CLI is actually in use here; otherwise nested repos'
  // fixtures would make it look "detected".
  const inUse = exists(dir) || sources.length > 0 || !!projectSettings;
  if (inUse) {
    for (const d of descendants(ctx.cwd)) {
      for (const name of names) {
        sources.push(...instructionSources(ctx, path.join(d, name), seen, { withImports: true }));
      }
    }
  }

  const mcp: McpServerConfig[] = [];
  mcp.push(...mcpFromObject(userSettings?.mcpServers, disp(ctx, userSettingsPath), 'user', ctx));

  // Extensions: ~/.gemini/extensions/<name>/gemini-extension.json
  const extRoot = path.join(dir, 'extensions');
  for (const e of listDir(extRoot)) {
    if (!direntIsDir(extRoot, e)) continue;
    const extDir = path.join(extRoot, e.name);
    const manifestPath = path.join(extDir, 'gemini-extension.json');
    const manifest = obj(readJson(manifestPath));
    if (!manifest) continue;
    const extName = typeof manifest.name === 'string' ? manifest.name : e.name;
    mcp.push(...mcpFromObject(manifest.mcpServers, disp(ctx, manifestPath), 'extension', { ...ctx, cwd: extDir }));
    const cf = manifest.contextFileName;
    const files = typeof cf === 'string' ? [cf] : Array.isArray(cf) ? cf.map(String) : ['GEMINI.md'];
    for (const f of files) {
      for (const s of instructionSources(ctx, path.join(extDir, f), seen, { withImports: true })) {
        sources.push({ ...s, name: `${extName}/${s.name}` });
      }
    }
  }

  mcp.push(...mcpFromObject(projectSettings?.mcpServers, disp(ctx, projectSettingsPath), 'project', ctx));

  const excluded = new Set<string>();
  for (const s of [userSettings, projectSettings]) {
    const ex = obj(s?.mcp)?.excluded;
    if (Array.isArray(ex)) for (const n of ex) excluded.add(String(n));
  }
  const merged = mergeByName(mcp).map((s) => (excluded.has(s.name) ? { ...s, disabled: true } : s));

  const detected = inUse || merged.length > 0;
  return { id: 'gemini', sources, mcp: merged, notes, detected };
}
