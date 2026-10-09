'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const http = require('node:http');
const path = require('node:path');
async function client(t, vendor, handler, token = 'fixture-token') {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, [path.join(__dirname, '../src/server.js')], {
    env: { PATH: process.env.PATH, VENDOR: vendor, API_BASE_OVERRIDE: `http://127.0.0.1:${server.address().port}`,
      [require(`../vendors/${vendor}`).apiKeyEnv]: token }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  let next = 1, stderr = '';
  const pending = new Map();
  child.stderr.on('data', b => { stderr += b; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const response = JSON.parse(line);
    responses.push(response);
    if (pending.has(response.id)) { pending.get(response.id)(response); pending.delete(response.id); }
  });
  child.on('exit', () => { for (const done of pending.values()) done({ error: { message: stderr } }); pending.clear(); });
  t.after(async () => {
    if (child.exitCode === null) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const call = (name, args) => {
    const id = next++;
    const response = new Promise(resolve => pending.set(id, resolve));
    send({ id, method: 'tools/call', params: { name, arguments: args } });
    return { id, response };
  };
  return { call, send, pending, responses };
}
const text = response => JSON.parse(response.result.content[0].text);
test('20 omitted deployment IDs fail locally; native and generated deployment inputs reach mock API', { timeout: 5000 }, async t => {
  let calls = 0, received;
  const c = await client(t, 'vercel', (req, res) => {
    calls++;
    assert.doesNotMatch(req.url, /\{|\}/);
    let body = '';
    req.on('data', b => { body += b; });
    req.on('end', () => { received = { url: req.url, body: body && JSON.parse(body) }; res.end('{"ok":true}'); });
  });
  for (let i = 0; i < 20; i++) {
    const response = await c.call('get_deployment', {}).response;
    assert.equal(response.result.isError, true);
    assert.equal(text(response).error.code, 'missing_path_parameter');
    assert.equal(text(response).error.field, 'idOrUrl');
  }
  assert.equal(calls, 0);
  assert.equal((await c.call('get_deployment', { idOrUrl: 'dpl_fixture/encoded', teamId: null }).response).result.isError, false);
  assert.equal(received.url, '/v13/deployments/dpl_fixture%2Fencoded');
  const args = { body: { name: 'fixture', files: [{ file: 'index.html', data: 'hello' }] } };
  assert.equal((await c.call('create_deployment', args).response).result.isError, false);
  assert.deepEqual(received.body, args.body);
  const encoded = { body: { name: 'fixture', gitSource: '{"type":"github","ref":"main","repoId":123}' } };
  assert.equal((await c.call('create_deployment', encoded).response).result.isError, false);
  assert.deepEqual(received.body.gitSource, { type: 'github', ref: 'main', repoId: 123 });
  const before = calls;
  assert.equal((await c.call('create_deployment', { body: { name: 'fixture', files: ['{"file":123}'] } }).response).result.isError, true);
  assert.equal(calls, before);
});
test('MCP cancellation bounds a live stream while a sibling call remains responsive', { timeout: 5000 }, async t => {
  let open, close;
  const opened = new Promise(resolve => { open = resolve; });
  const closed = new Promise(resolve => { close = resolve; });
  const c = await client(t, 'vercel', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/stream+json' }); res.write('{"timestampInMs":150}\n');
    res.on('close', close); open();
  });
  const call = c.call('list_runtime_logs', { projectId: 'p', deploymentId: 'd', since: 100, until: 200 });
  await opened;
  const ping = new Promise(resolve => c.pending.set('ping', resolve));
  c.send({ id: 'ping', method: 'ping' });
  assert.deepEqual((await ping).result, {});
  c.send({ method: 'notifications/cancelled', params: { requestId: call.id } });
  await closed;
  const barrier = new Promise(resolve => c.pending.set('barrier', resolve));
  c.send({ id: 'barrier', method: 'ping' });
  await barrier;
  assert.ok(c.responses.every(response => response.id !== call.id));
});
test('Cloudflare inherited path variable is encoded and replaced', { timeout: 5000 }, async t => {
  let url;
  const c = await client(t, 'cloudflare', (req, res) => { url = req.url; res.end('{"success":true}'); });
  assert.equal((await c.call('get_settings_csam_scanner_third_party', { zone_id: 'fixture/zone' }).response).result.isError, false);
  assert.match(url, /fixture%2Fzone/); assert.doesNotMatch(url, /\{|\}/);
});
test('corrected Vercel header and query names reach mock HTTP; uploads use raw bytes', { timeout: 5000 }, async t => {
  let received;
  const c = await client(t, 'vercel', (req, res) => {
    let body = '';
    req.on('data', b => { body += b; });
    req.on('end', () => { received = { url: req.url, headers: req.headers, body }; res.end('{"ok":true}'); });
  });
  const uploaded = await c.call('upload_file', { 'x-Vercel-Digest': 'fixture-digest', body: 'hello' }).response;
  assert.equal(uploaded.result.isError, false, JSON.stringify(uploaded));
  assert.equal(received.body, 'hello'); assert.equal(received.headers['content-type'], 'application/octet-stream');
  assert.equal(received.headers['x-vercel-digest'], 'fixture-digest'); assert.equal(received.headers['content-length'], '5');
  const excluded = await c.call('list_shared_env_variables', { 'exclude-ids': 'fixture-id' }).response;
  assert.equal(excluded.result.isError, false, JSON.stringify(excluded)); assert.match(received.url, /exclude-ids=fixture-id/);
});
test('advertised runtime-log schema includes bounded query controls', { timeout: 5000 }, async t => {
  const c = await client(t, 'vercel', (req, res) => res.end('{}'));
  const listing = new Promise(resolve => c.pending.set('list', resolve));
  c.send({ id: 'list', method: 'tools/list' });
  const tools = (await listing).result.tools;
  assert.equal(tools.length, 333);
  const runtime = tools.find(t => t.name === 'list_runtime_logs');
  for (const field of ['projectId', 'deploymentId', 'limit', 'since', 'until']) {
    assert.ok(runtime.inputSchema.properties[field]); assert.equal(runtime.inputSchema.required.includes(field), ['projectId', 'deploymentId'].includes(field));
  }
  assert.match(runtime.description, /750 ms idle gap, 10 s total, 2 MiB cap/);
});
test('redaction preserves ordinary arguments and removes secrets echoed by the vendor', { timeout: 5000 }, async t => {
  const c = await client(t, 'vercel', (req, res) => { res.writeHead(400); res.end(JSON.stringify({ error: { code: 'invalid_env', message: 'project fixture-project secret fixture-password token fixture-token' } })); });
  const response = await c.call('create_deployment', { body: { name: 'fixture-project', env: { PASSWORD: 'fixture-password' } } }).response;
  assert.match(text(response).error.message, /fixture-project/);
  assert.doesNotMatch(text(response).error.message, /fixture-token|fixture-password/);
});
test('controlled headers are absent from listing and caller values fail before HTTP', { timeout: 5000 }, async t => {
  let calls = 0;
  const c = await client(t, 'vercel', (req, res) => { calls++; res.end('{}'); });
  const listing = new Promise(resolve => c.pending.set('headers-list', resolve));
  c.send({ id: 'headers-list', method: 'tools/list' });
  const upload = (await listing).result.tools.find(x => x.name === 'upload_file');
  assert.match(upload.inputSchema.properties.body.description, /UTF-8 text/);
  assert.ok(Object.keys(upload.inputSchema.properties).every(x => !/^(content-length|host|authorization|content-type|transfer-encoding)$/i.test(x)));
  const response = await c.call('upload_file', { 'content-Length': 99, 'x-Vercel-Digest': 'fixture-digest', body: 'hello' }).response;
  assert.equal(response.result.isError, true); assert.equal(calls, 0);
});
test('old tool names route as hidden aliases and ambiguous names stay rejected', { timeout: 5000 }, async t => {
  const c = await client(t, 'stripe', (req, res) => res.end('{}'), '');
  const aliases = require('../src/legacyAliases').stripe;
  const old = 'create_test_helpers_treasury_outbound_transfers_outbound_transfer_fail';
  const args = { outbound_transfer: 'obt_123' };
  const canonical = await c.call(aliases[old], args).response;
  const legacy = await c.call(old, args).response;
  assert.equal(legacy.result.isError, canonical.result.isError);
  assert.match(legacy.result.content[0].text, /\/fail/);
  const ambiguous = await c.call('create_test_helpers_issuing_personalization_designs_personalization_desig_3', {}).response;
  assert.equal(ambiguous.result.isError, true);
  const listing = new Promise(resolve => c.pending.set('aliases-list', resolve));
  c.send({ id: 'aliases-list', method: 'tools/list' });
  assert.ok((await listing).result.tools.every(x => !Object.hasOwn(aliases, x.name)));
});
test('default runtime window includes live entries after call start', { timeout: 5000 }, async t => {
  const c = await client(t, 'vercel', (req, res) => res.end(JSON.stringify({ timestampInMs: Date.now() + 100, message: 'live' }) + '\n'));
  const response = await c.call('list_runtime_logs', { projectId: 'p', deploymentId: 'd' }).response;
  const body = text(response);
  assert.equal(body.entries[0].message, 'live');
  assert.equal(body.until - body.since, 15 * 60 * 1000 + 10000);
});
