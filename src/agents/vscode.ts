import path from 'node:path';
import { readJson, readText, walkFiles } from '../fsutil.js';
import { fmString, parseFrontmatter } from '../frontmatter.js';
import { countTokens } from '../tokens.js';
import type { AgentScan, McpServerConfig, ScanContext, Source } from '../types.js';
import { disp, instructionSources, mcpFromObject, mergeByName } from './common.js';

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function vscodeUserDir(home: string): string {
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'Code', 'User');
  return path.join(home, '.config', 'Code', 'User');
}

export function scanVscode(ctx: ScanContext): AgentScan {
  const projectRoot = ctx.repoRoot ?? ctx.cwd;
  const seen = new Set<string>();
  const sources: Source[] = [];
  const notes: string[] = [];

  sources.push(...instructionSources(ctx, path.join(projectRoot, '.github', 'copilot-instructions.md'), seen));

  // Path-specific instructions: .github/instructions/*.instructions.md (applyTo globs)
  const instrDir = path.join(projectRoot, '.github', 'instructions');
  for (const file of walkFiles(instrDir, (n) => n.endsWith('.instructions.md'), 4)) {
    const text = readText(file) ?? '';
    const fm = parseFrontmatter(text);
    const applyTo = fmString(fm.data, 'applyTo');
    const always = applyTo === '**' || applyTo === '**/*';
    sources.push({
      kind: 'rule',
      name: path.basename(file),
      path: file,
      displayPath: disp(ctx, file),
      tokens: countTokens(fm.body),
      loading: always ? 'always' : 'conditional',
      note: applyTo ? `applyTo: ${applyTo}` : 'manual',
      text: fm.body,
    });
  }

  const mcp: McpServerConfig[] = [];
  const userMcp = path.join(vscodeUserDir(ctx.home), 'mcp.json');
  const workspaceMcp = path.join(projectRoot, '.vscode', 'mcp.json');
  mcp.push(...mcpFromObject(obj(readJson(userMcp))?.servers, disp(ctx, userMcp), 'user', ctx));
  mcp.push(...mcpFromObject(obj(readJson(workspaceMcp))?.servers, disp(ctx, workspaceMcp), 'project', ctx));

  const detected = sources.length > 0 || mcp.length > 0;
  return { id: 'vscode', sources, mcp: mergeByName(mcp), notes, detected };
}
