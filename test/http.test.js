'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { request } = require('../src/http');
async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const logs = { since: 100, until: 200, limit: 2 };
test('non-terminating logs stop at entry limit, filter the window and close upstream', async t => {
  let close;
  const closed = new Promise(resolve => { close = resolve; });
  const url = await fixture(t, (req, res) => {
    res.on('close', close);
    res.writeHead(200, { 'Content-Type': 'application/stream+json' });
    res.write('{"timestampInMs":99}\n{"timestampInMs":150,"message":"one"}\n');
    res.write('{"timestampInMs":160,"message":"two"}\n{"timestampInMs":170}\n');
  });
  const out = await request({ url, method: 'GET', logs, budget: { requestMs: 1000, idleMs: 100 } });
  assert.equal(out.body.stopped, 'limit');
  assert.deepEqual(out.body.entries.map(x => x.message), ['one', 'two']);
  await closed;
});
test('empty and partially filled streams return at idle gap', async t => {
  const url = await fixture(t, (req, res) => { res.writeHead(200); res.flushHeaders(); if (req.url === '/one') res.write('{"timestampInMs":150}\n'); });
  for (const path of ['', '/one']) {
    const out = await request({ url: url + path, method: 'GET', logs, budget: { requestMs: 1000, idleMs: 20 } });
    assert.equal(out.body.stopped, 'idle'); assert.equal(out.body.entries.length, path ? 1 : 0);
  }
});
test('deadline returns collected entries; cancellation does not become success', async t => {
  const url = await fixture(t, (req, res) => { res.writeHead(200); res.write('{"timestampInMs":150}\n'); });
  const out = await request({ url, method: 'GET', logs, budget: { requestMs: 40, idleMs: 1000 } });
  assert.equal(out.body.stopped, 'deadline'); assert.equal(out.body.entries.length, 1);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await request({ url, method: 'GET', logs, signal: controller.signal });
  assert.equal(cancelled.body.error.code, 'cancelled');
});
test('deadline covers header stalls and normal JSON body stalls', async t => {
  const url = await fixture(t, (req, res) => { if (req.url === '/body') { res.writeHead(200); res.write('{'); } });
  const headerTimeout = await request({ url, method: 'GET', logs, budget: { requestMs: 20 } });
  assert.equal(headerTimeout.body.error.code, 'request_timeout');
  assert.equal(headerTimeout.status, 0);
  for (const suffix of ['', '/body']) {
    const out = await request({ url: url + suffix, method: 'POST', budget: { requestMs: 20 } });
    assert.equal(out.body.error.code, 'request_timeout');
    assert.match(out.body.error.completion, /unknown/);
  }
});
test('stream parser handles split UTF-8, SSE and final NDJSON line', async t => {
  const url = await fixture(t, (req, res) => {
    res.writeHead(200);
    const bytes = Buffer.from(': heartbeat\n\ndata: {"timestampInMs":150,"message":"héllo"}\n\n{"timestampInMs":160}');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    res.write(bytes.subarray(0, split)); res.end(bytes.subarray(split));
  });
  const out = await request({ url, method: 'GET', logs: { ...logs, limit: 10 } });
  assert.equal(out.body.entries[0].message, 'héllo'); assert.equal(out.body.entries.length, 2); assert.equal(out.body.stopped, 'eof');
});
test('malformed streams fail; byte cap and redirects remain bounded', async t => {
  const url = await fixture(t, (req, res) => {
    if (req.url === '/bad') res.end('not json\n');
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/target' }); res.end(); }
    else res.end('x'.repeat(1000));
  });
  const bad = await request({ url: url + '/bad', method: 'GET', logs });
  assert.equal(bad.body.error.code, 'invalid_response');
  const capped = await request({ url, method: 'GET', logs, budget: { maxBytes: 10 } });
  assert.equal(capped.body.stopped, 'byte_limit');
  const redirect = await request({ url: url + '/redirect', method: 'GET' });
  assert.equal(redirect.body.error.code, 'network_error');
});
test('Vercel, Stripe and Cloudflare errors include status/code/message and redact credentials', async t => {
  const url = await fixture(t, (req, res) => {
    res.writeHead(403);
    const error = { code: 'forbidden', message: 'Bearer fixture-token password=hidden-value fixture-secret' };
    res.end(JSON.stringify(req.url === '/cloudflare' ? { errors: [error], token: 'fixture-token' } : { error, request: 'fixture-secret' }));
  });
  for (const suffix of ['/vercel', '/stripe', '/cloudflare']) {
    const out = await request({ url: url + suffix, method: 'GET', secrets: ['fixture-token', 'fixture-secret'] });
    assert.equal(out.status, 403); assert.equal(out.body.error.status, 403); assert.equal(out.body.error.code, 'forbidden');
    assert.doesNotMatch(JSON.stringify(out), /fixture-token|fixture-secret|hidden-value/);
  }
});
