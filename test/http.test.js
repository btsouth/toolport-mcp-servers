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
test('malformed stream lines are counted; byte cap and redirects remain bounded', async t => {
  const url = await fixture(t, (req, res) => {
    if (req.url === '/bad') res.end('not json\n');
    else if (req.url === '/redirect') { res.writeHead(302, { Location: '/target' }); res.end(); }
    else res.end('x'.repeat(1000));
  });
  const bad = await request({ url: url + '/bad', method: 'GET', logs });
  assert.equal(bad.body.skippedLines, 1); assert.deepEqual(bad.body.entries, []);
  const capped = await request({ url, method: 'GET', logs, budget: { maxBytes: 10 } });
  assert.equal(capped.body.stopped, 'byte_limit');
  const redirect = await request({ url: url + '/redirect', method: 'GET' });
  assert.equal(redirect.status, 302); assert.equal(redirect.body.error.status, 302);
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
test('vendor error details stay bounded and retain useful parameter diagnostics', async t => {
  const url = await fixture(t, (req, res) => {
    res.writeHead(402);
    res.end(JSON.stringify({ error: { code: 'card_declined', message: 'Unknown customer cus_123 for acct_123', param: 'payment_method', decline_code: 'insufficient_funds', long_message: 'Details ' + 'x'.repeat(500), secret: 'fixture-secret' } }));
  });
  const out = await request({ url, method: 'POST', secrets: ['fixture-secret'] });
  assert.match(out.body.error.message, /cus_123.*acct_123/);
  assert.equal(out.body.error.param, 'payment_method');
  assert.equal(out.body.error.decline_code, 'insufficient_funds');
  assert.ok(out.body.error.long_message.length <= 300);
  assert.equal(out.body.error.secret, undefined);
});
test('network errors expose the transport cause without raw URLs', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const out = await request({ url: `http://127.0.0.1:${port}`, method: 'GET' });
  assert.equal(out.body.error.code, 'network_error');
  assert.equal(out.body.error.cause, 'ECONNREFUSED');
  assert.doesNotMatch(out.body.error.message, /127\.0\.0\.1/);
});
test('bad runtime lines preserve valid entries before and after them', async t => {
  const url = await fixture(t, (req, res) => res.end('{"timestampInMs":150,"message":"before"}\ninvalid\nnull\n{"timestampInMs":160,"message":"after"}\n'));
  const out = await request({ url, method: 'GET', logs: { ...logs, limit: 10 } });
  assert.deepEqual(out.body.entries.map(x => x.message), ['before', 'after']);
  assert.equal(out.body.skippedLines, 2);
});

test('redirects report sanitized absolute and relative Location without following', async t => {
  let followed = 0;
  const url = await fixture(t, (req, res) => {
    if (req.url === '/absolute') res.writeHead(302, { Location: 'https://user:password@example.com/target?token=hidden#secret' });
    else if (req.url === '/relative') res.writeHead(307, { Location: '/target?access_token=hidden#secret' });
    else if (req.url === '/scheme-relative') res.writeHead(303, { Location: '//user:password@example.com/target?code=hidden' });
    else if (req.url === '/missing') res.writeHead(302);
    else { followed++; res.writeHead(200); }
    res.end();
  });
  for (const [suffix, expected] of [['/absolute', 'https://example.com/target'], ['/relative', '/target'], ['/scheme-relative', '//example.com/target']]) {
    const out = await request({ url: url + suffix, method: 'GET' });
    assert.equal(out.body.error.location, expected);
    assert.doesNotMatch(JSON.stringify(out), /hidden|password|user:|secret/);
  }
  assert.equal((await request({ url: url + '/missing', method: 'GET' })).body.error.location, undefined);
  assert.equal(followed, 0);
});
