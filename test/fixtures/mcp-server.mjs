#!/usr/bin/env node
// Tiny MCP stdio server used by the test-suite. Built with the official SDK.
// Env:
//   FIXTURE_PAGE_SIZE  paginate tools/list with this page size (default: no pagination)
//   FIXTURE_TOOLS      number of extra generated tools (default 0)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const TOOLS = [
  {
    name: 'search_issues',
    description: 'Search issues in a repository using a query string. Returns matching issues with title, state and URL.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'owner/name of the repository' },
        query: { type: 'string', description: 'Search query' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
      required: ['repo', 'query'],
    },
  },
  {
    name: 'get_file',
    description: 'Read a file from the repository.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'ping',
    description: 'Health check.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const extra = Number(process.env.FIXTURE_TOOLS ?? 0);
for (let i = 0; i < extra; i++) {
  TOOLS.push({
    name: `generated_${i}`,
    description: `Generated tool number ${i}.`,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  });
}

const pageSize = Number(process.env.FIXTURE_PAGE_SIZE ?? 0);

const server = new Server(
  { name: 'fixture-server', version: '1.2.3' },
  { capabilities: { tools: {}, prompts: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  if (!pageSize) return { tools: TOOLS };
  const start = Number(req.params?.cursor ?? 0);
  const page = TOOLS.slice(start, start + pageSize);
  const next = start + pageSize < TOOLS.length ? String(start + pageSize) : undefined;
  return next ? { tools: page, nextCursor: next } : { tools: page };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [{ name: 'triage', description: 'Triage new issues' }],
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'file:///README.md', name: 'README', description: 'Project readme' },
    { uri: 'file:///CHANGELOG.md', name: 'CHANGELOG' },
  ],
}));

await server.connect(new StdioServerTransport());
