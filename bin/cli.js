#!/usr/bin/env node
'use strict';
// npx toolport-mcp-servers <vendor>   e.g.  npx -y toolport-mcp-servers stripe
// Selects the vendor, then runs the MCP stdio server (reads bundled data/).
const SERVERS = ['stripe', 'vercel', 'clerk'];
const arg = (process.argv[2] || process.env.VENDOR || '').toLowerCase();
const vendor = SERVERS.includes(arg) ? arg : 'stripe';
if (arg && !SERVERS.includes(arg)) {
  process.stderr.write(`toolport-mcp-servers: unknown server "${arg}". Available: ${SERVERS.join(', ')}. Defaulting to stripe.\n`);
}
process.env.VENDOR = vendor;
require('../src/server.js');
