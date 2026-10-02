import path from 'node:path';
import { exists, readJson, readText, walkFiles } from '../fsutil.js';
import { fmBool, fmString, parseFrontmatter } from '../frontmatter.js';
import { countTokens } from '../tokens.js';
import type { AgentScan, McpServerConfig, ScanContext, Source } from '../types.js';
import { disp, instructionSources, mcpFromObject, mergeByName, skillSources } from './common.js';

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function scanCursor(ctx: ScanContext): AgentScan {
  const projectRoot = ctx.repoRoot ?? ctx.cwd;
  const seen = new Set<string>();
  const sources: Source[] = [];
  const notes: string[] = [];

  // Legacy single rules file: always applied.
  for (const d of [...new Set([projectRoot, ctx.cwd])]) {
    sources.push(...instructionSources(ctx, path.join(d, '.cursorrules'), seen));
  }

  // Project rules (.mdc / .md) with frontmatter: alwaysApply, description, globs.
  for (const d of [...new Set([projectRoot, ctx.cwd])]) {
    const rulesDir = path.join(d, '.cursor', 'rules');
    for (const file of walkFiles(rulesDir, (n) => n.endsWith('.mdc') || n.endsWith('.md'), 6)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readText(file) ?? '';
      const fm = parseFrontmatter(text);
      const always = fmBool(fm.data, 'alwaysApply');
      const description = fmString(fm.data, 'description');
      const globs = fmString(fm.data, 'globs');
      let note: string;
      if (always) note = 'alwaysApply';
      else if (globs) note = `auto-attached: ${globs}`;
      else if (description) note = 'agent-requested';
      else note = 'manual (@rule)';
      sources.push({
        kind: 'rule',
        name: path.relative(rulesDir, file).split(path.sep).join('/'),
        path: file,
        displayPath: disp(ctx, file),
        tokens: countTokens(always ? text : fm.body),
        loading: always ? 'always' : 'conditional',
        note,
        text: always ? text : fm.body,
      });
      // Agent-requested rules still put their description in context.
      if (!always && description && !globs) {
        sources.push({
          kind: 'rule',
          name: `${path.basename(file)} (description)`,
          path: file,
          displayPath: disp(ctx, file),
          tokens: countTokens(`- ${description}`),
          loading: 'always',
          note: 'rule description',
        });
      }
    }
  }

  sources.push(
    ...skillSources(ctx, [path.join(ctx.home, '.cursor', 'skills'), path.join(projectRoot, '.cursor', 'skills')], seen, notes),
  );

  const mcp: McpServerConfig[] = [];
  const userMcp = path.join(ctx.home, '.cursor', 'mcp.json');
  const projMcp = path.join(projectRoot, '.cursor', 'mcp.json');
  mcp.push(...mcpFromObject(obj(readJson(userMcp))?.mcpServers, disp(ctx, userMcp), 'user', ctx));
  mcp.push(...mcpFromObject(obj(readJson(projMcp))?.mcpServers, disp(ctx, projMcp), 'project', ctx));

  const detected = exists(path.join(ctx.home, '.cursor')) || sources.length > 0 || mcp.length > 0;
  if (detected) notes.push('User Rules from Cursor Settings are stored in the app, not on disk, and are not counted.');
  return { id: 'cursor', sources, mcp: mergeByName(mcp), notes, detected };
}
