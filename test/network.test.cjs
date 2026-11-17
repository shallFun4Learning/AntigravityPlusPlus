const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const {
  createProxyFetch,
  requestViaHttpProxy
} = require('../features/network');

async function startProxy(handler) {
  const proxy = http.createServer(handler);
  proxy.on('connect', (_request, socket) => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  return proxy;
}

test('proxy fetch sends external HTTP requests through the configured local proxy', async t => {
  const calls = [];
  const proxy = await startProxy((request, response) => {
    calls.push({
      method: request.method,
      url: request.url,
      headers: request.headers
    });
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, body }));
    });
  });
  t.after(() => proxy.close());

  const fetchThroughProxy = createProxyFetch({
    settings: { get: () => ({ enableProxy: true, port: proxy.address().port }) },
    directFetch: async () => {
      throw new Error('不应绕过本地代理');
    }
  });
  const response = await fetchThroughProxy('http://accounts.example.test/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code' })
  });

  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), {
    ok: true,
    body: 'grant_type=authorization_code'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'http://accounts.example.test/token');
  assert.equal(calls[0].headers.host, 'accounts.example.test');
});

test('proxy fetch leaves loopback requests and disabled proxy requests on direct fetch', async () => {
  const calls = [];
  const directFetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  const fetchThroughProxy = createProxyFetch({
    settings: { get: () => ({ enableProxy: false, port: 65535 }) },
    directFetch
  });

  await fetchThroughProxy('https://accounts.google.com/token');
  await fetchThroughProxy('http://127.0.0.1:43210/callback');

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://accounts.google.com/token');
  assert.equal(calls[1].url, 'http://127.0.0.1:43210/callback');
});

test('HTTPS proxy failure reports the local proxy endpoint', async t => {
  const proxy = await startProxy((request, response) => {
    response.writeHead(502);
    response.end();
  });
  t.after(() => proxy.close());

  await assert.rejects(
    () => requestViaHttpProxy(
      'https://oauth2.googleapis.com/token',
      { method: 'POST', body: 'x=1' },
      proxy.address().port,
      1000
    ),
    /代理隧道握手失败/
  );
});
