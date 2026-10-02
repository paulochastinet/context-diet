#!/usr/bin/env node
// Never answers the MCP handshake and ignores stdin EOF / SIGTERM: exercises timeouts + kill.
import { writeFileSync } from 'node:fs';

if (process.env.FIXTURE_PID_FILE) writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid));
process.on('SIGTERM', () => {});
process.stdin.on('data', () => {});
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);
