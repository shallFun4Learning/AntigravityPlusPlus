const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { ContextMonitor, summarizeMetadata, resolveEndpointModel, seconds } = require('../features/context-monitor');
const { QuotaMonitor } = require('../features/quota-monitor');
const { LanguageService } = require('../adapters/desktop/language-service');
const { serverFromDiscovery, serverFromDaemon, parseNetstat, parsePs, parseLsof } = require('../adapters/desktop/language-service-discovery');
const { CdpHub } = require('../adapters/desktop/cdp');
const { normalizeSettings, assertLaunchSettingsMutable } = require('../core/settings');

const id = '11111111-1111-1111-1111-111111111111';
const otherId = '22222222-2222-2222-2222-222222222222';
const chat = (used = 40, max = 100, extra = {}) => ({ chatModel: { modelDisplayName: 'Example',
  usage: { messageId: 'a', outputTokens: '200', thinkingOutputTokens: '100' }, streamingDuration: '2s', timeToFirstToken: '0.5s',
  chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: used, maxContextTokens: max, tokenBreakdown: { body: 'private text' } } }, ...extra } });

test('context is the latest request estimate; zero, compaction and over-capacity are honest', () => {
  const result = summarizeMetadata([chat(90), chat(20)]);
  assert.equal(result.context.usedTokens, 20);
  assert.equal(result.context.usedFraction, .2);
  assert.equal(summarizeMetadata([chat(0)]).context.usedFraction, 0);
  assert.equal(summarizeMetadata([chat(120)]).context.usedFraction, 1.2);
  assert.equal(summarizeMetadata([chat(20, null)]).context.maxTokens, null);
  for (const invalid of [null, '', true, -1, Infinity, {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(summarizeMetadata([chat(invalid)]).context, null);
  }
  assert.equal(summarizeMetadata([chat(), { chatModel: {} }]).context, null, 'Never reuse previous model capacity');
  assert.doesNotMatch(JSON.stringify(result), /private text|tokenBreakdown|usage/);
});

test('latest valid speed excludes thinking and TTFT, with explicit fallback and short-sample labels', () => {
  let result = summarizeMetadata([chat()]);
  assert.equal(result.speed.tokensPerSecond, 50);
  assert.equal(result.speed.ttftSeconds, .5);
  assert.equal(result.speed.basis, 'response');
  result = summarizeMetadata([chat(40, 100, { usage: { outputTokens: '100' }, streamingDuration: '.2s' })]);
  assert.equal(result.speed, null, 'Malformed durations are not guessed');
  result = summarizeMetadata([chat(40, 100, { usage: { outputTokens: '100' }, streamingDuration: '0.2s' })]);
  assert.equal(result.speed.tokensPerSecond, 500);
  assert.equal(result.speed.basis, 'all-output');
  assert.equal(result.speed.shortSample, true);
  for (const value of [undefined, null, {}, 'wrong', -1]) assert.equal(seconds(value), null);
  assert.equal(seconds({ seconds: '2', nanos: 500000000 }), 2.5);
  const a = chat();
  assert.equal(summarizeMetadata([a, chat(40, 100, { usage: { messageId: 'b', responseOutputTokens: 80 }, streamingDuration: '4s' }), a]).speed.tokensPerSecond, 20);
});

test('discovery requires exactly one current-user backend and a PID-owned HTTP port', () => {
  const rows = [{ pid: 9, command: 'language_server.exe --standalone --csrf_token=private', ports: new Set([4001]) }];
  const log = 'listening on random port at 4001 for HTTP\nlistening on random port at 9999 for HTTP\n';
  assert.deepEqual(serverFromDiscovery(log, rows), { pid: 9, port: 4001, csrf: 'private' });
  assert.throws(() => serverFromDiscovery(log, [...rows, ...rows]), /多个/);
  assert.throws(() => serverFromDiscovery('listening on random port at 9999 for HTTP\n', rows));
  assert.deepEqual([...parseNetstat(' TCP  [::]:4001 [::]:0 LISTENING 9\n TCP 127.0.0.1:12 0.0.0.0:0 ESTABLISHED 8').get(9)], [4001]);
  assert.equal(parsePs('9 100 /bin/language_server --standalone\n10 200 /bin/language_server --standalone', 100).length, 1);
  assert.deepEqual([...parseLsof('p9\nn[::1]:4001\n').get(9)], [4001]);
});

test('read-only RPC uses loopback credentials in headers and bounds allowed methods', async t => {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ url: request.url, token: request.headers['x-codeium-csrf-token'] });
    response.end(JSON.stringify({ userStatus: { email: 'account@example.test' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new LanguageService({ profile: 'unused', processes: async () => [], readLog: async () => '' });
  client.server = { pid: 9, port: server.address().port, csrf: 'private' }; client.discoveredAt = Date.now();
  assert.equal((await client.call('GetUserStatus')).userStatus.email, 'account@example.test');
  assert.equal(calls[0].token, 'private');
  assert.match(calls[0].url, /LanguageServerService\/GetUserStatus$/);
  await assert.rejects(client.call('SetUserStatus'), /不支持/);
  client.reset(); assert.equal(client.server, null);
});

test('desktop discovery probes PID-owned ports when the startup log is truncated', async t => {
  const received = [];
  const server = http.createServer((request, response) => {
    received.push({ path: request.url, token: request.headers['x-codeium-csrf-token'] });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ userStatus: { email: 'account@example.test' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const port = server.address().port;
  const client = new LanguageService({
    profile: 'unused',
    processes: async () => [{
      pid: 9,
      command: 'language_server --standalone --csrf_token=private',
      ports: new Set([port])
    }],
    readLog: async () => 'recent log entries without the startup port\n'
  });
  assert.deepEqual(await client.discover(), { pid: 9, port, csrf: 'private' });
  assert.equal(received.length, 1);
  assert.equal(received[0].token, 'private');
});

test('desktop 2.34 discovers the same verified backend for both monitors without the old argument', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'easyag-daemon-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const responses = {
    GetUserStatus: { userStatus: { email: 'account@example.test' } },
    GetCascadeTrajectoryGeneratorMetadata: { numTotalGeneratorMetadata: 1, generatorMetadata: [chat()] },
    RetrieveUserQuotaSummary: { groups: [{ displayName: 'Gemini Models', buckets: [{ remainingFraction: .73 }] }] }
  };
  const calls = [];
  const server = http.createServer((request, response) => {
    const method = request.url.split('/').at(-1);
    calls.push(method);
    if (request.headers['x-codeium-csrf-token'] !== 'fixture-token' || !Object.hasOwn(responses, method)) {
      response.writeHead(403).end();
      return;
    }
    response.end(JSON.stringify(responses[method]));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });

  const port = server.address().port;
  const row = { pid: 17, command: 'language_server --standalone --app_data_dir=antigravity-test', ports: new Set([port]) };
  const directory = path.join(home, '.gemini', 'antigravity-test', 'daemon');
  const descriptor = path.join(directory, `hub_${port}.json`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(descriptor, JSON.stringify({ pid: 18, httpPort: port, csrfToken: 'fixture-token' }), { mode: 0o600 });
  assert.equal(await serverFromDaemon(row, home), null, 'An old daemon PID must not be accepted');
  await fs.writeFile(descriptor, JSON.stringify({ pid: 17, httpPort: port === 65535 ? 65534 : port + 1, csrfToken: 'fixture-token' }));
  assert.equal(await serverFromDaemon(row, home), null, 'The descriptor must match the PID-owned port');
  await fs.writeFile(descriptor, JSON.stringify({ pid: 17, httpPort: port, csrfToken: 'fixture-token' }));
  if (process.getuid) {
    await fs.chmod(descriptor, 0o644);
    assert.equal(await serverFromDaemon(row, home), null, 'Shared credentials are ignored');
    await fs.chmod(descriptor, 0o600);
  }
  const client = new LanguageService({
    processes: async () => [row],
    readDaemon: candidate => serverFromDaemon(candidate, home)
  });
  const [context, quota] = await Promise.all([new ContextMonitor(client).sample(id), new QuotaMonitor(client).sample()]);
  assert.equal(context.state, 'live');
  assert.equal(context.context.usedTokens, 40);
  assert.equal(quota.state, 'live');
  assert.equal(quota.groups[0].buckets[0].remainingFraction, .73);
  assert.equal(calls.filter(method => method === 'GetCascadeTrajectoryGeneratorMetadata').length, 1);
  assert.equal(calls.includes('GetCascadeTrajectory'), false);
});

test('metadata reads bounded pages directly without requesting a trajectory', async () => {
  const client = new LanguageService();
  const calls = [];
  client.call = async (method, body) => {
    calls.push([method, body]);
    return { cascadeId: id, numTotalGeneratorMetadata: 2, generatorMetadata: [chat(40 - body.generatorMetadataOffset * 20)] };
  };
  assert.deepEqual(await client.metadata(id), [chat(), chat(20)]);
  assert.deepEqual(calls, [0, 1].map(generatorMetadataOffset => [
    'GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset }
  ]));
  await assert.rejects(client.metadata(otherId), /不匹配/);

  client.call = async (_, body) => ({ generatorMetadatas: body.generatorMetadataOffset === 0 ? [chat()] : [] });
  assert.deepEqual(await client.metadata(id), [chat()], 'Pages without a count end at the first empty page');
  client.call = async () => ({ numTotalGeneratorMetadata: 2, generatorMetadata: [] });
  await assert.rejects(client.metadata(id), /分页/);
  client.call = async () => ({ numTotalGeneratorMetadata: 10001, generatorMetadata: [] });
  await assert.rejects(client.metadata(id), /范围/);
});

test('only an unsupported first metadata request falls back to the legacy trajectory', async () => {
  const client = new LanguageService();
  for (const statusCode of [404, 405, 501]) {
    const calls = [];
    client.call = async (method, body) => {
      calls.push(method);
      if (method === 'GetCascadeTrajectory') {
        return { trajectory: { cascadeId: id, steps: ['private body'], generatorMetadata: [chat()] }, numTotalGeneratorMetadata: 2 };
      }
      if (body.generatorMetadataOffset === 0) throw Object.assign(new Error('Unsupported'), { statusCode });
      return { generatorMetadata: [chat(20)] };
    };
    assert.deepEqual(await client.metadata(id), [chat(), chat(20)]);
    assert.deepEqual(calls, ['GetCascadeTrajectoryGeneratorMetadata', 'GetCascadeTrajectory', 'GetCascadeTrajectoryGeneratorMetadata']);
  }
  for (const [statusCode, offset] of [[403, 0], [500, 0], [404, 1]]) {
    const error = Object.assign(new Error('Metadata read failed'), { statusCode });
    client.call = async (method, body) => {
      assert.equal(method, 'GetCascadeTrajectoryGeneratorMetadata');
      if (body.generatorMetadataOffset === offset) throw error;
      return { numTotalGeneratorMetadata: 2, generatorMetadata: [chat()] };
    };
    await assert.rejects(client.metadata(id), error);
  }
});

test('an HTTP 404 for a missing conversation ends metadata collection', async t => {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push(request.url.split('/').at(-1));
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 'not_found' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new LanguageService({ processes: async () => [] });
  client.server = { pid: 9, port: server.address().port, csrf: 'fixture-token' };
  client.discoveredAt = Date.now();
  await assert.rejects(client.metadata(id), { statusCode: 404, connectNotFound: true });
  assert.deepEqual(calls, ['GetCascadeTrajectoryGeneratorMetadata']);
});

function mockClient() {
  const server = { pid: 9, port: 4001, csrf: 'secret' };
  return { discover: async () => server, call: async () => ({ userStatus: { email: 'account@example.test' } }),
    metadata: async () => [chat()], reset() {} };
}

test('monitor merges concurrent requests and sends only statistics, never identity or credentials', async () => {
  const client = mockClient(), monitor = new ContextMonitor(client);
  let count = 0;
  client.metadata = async () => { count++; return [chat()]; };
  const a = monitor.sample(id), b = monitor.sample(id);
  assert.equal(a, b);
  const result = await a;
  assert.equal(count, 1); assert.equal(result.state, 'live');
  assert.doesNotMatch(JSON.stringify(result), /account@|secret|private text|tokenBreakdown/);
});

test('account switches, backend restarts, missing identity and reset reject old statistics', async () => {
  for (const change of ['account', 'backend', 'missing', 'reset']) {
    const client = mockClient(), monitor = new ContextMonitor(client);
    let calls = 0;
    client.call = async () => ({ userStatus: { email: change === 'missing' ? null : ++calls > 1 && change === 'account' ? 'new@example.test' : 'old@example.test' } });
    if (change === 'backend') { let discovers = 0; client.discover = async () => ({ pid: ++discovers, port: 4001, csrf: 'secret' }); }
    if (change === 'reset') client.metadata = async () => { monitor.reset(); return [chat()]; };
    const result = await monitor.sample(id);
    assert.equal(result.state, 'unavailable', change);
    assert.equal(result.context, null);
  }
});

test('context monitoring remains optional and can be toggled while running', () => {
  assert.equal(normalizeSettings({}).enableContextMonitor, true);
  assert.equal(normalizeSettings({ enableContextMonitor: false }).enableContextMonitor, false);
  assert.throws(() => normalizeSettings({ enableContextMonitor: 'false' }));
  assert.doesNotThrow(() => assertLaunchSettingsMutable({ enableContextMonitor: false }, normalizeSettings(), 'running'));
});

test('the application samples and clears only the requested enabled monitor', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createApplication } = require('../desktop/application');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = createApplication({ rootDir: path.resolve(__dirname, '..'), dataDir: dir });
  // No server or session is started. Only these two synthetic samplers are callable.
  app.session.phase = 'running';
  const samples = [], resets = [];
  app.contextMonitor.sample = async () => { samples.push('context'); return { conversationId: id }; };
  app.quotaMonitor.sample = async () => { samples.push('quota'); return { groups: [] }; };
  app.contextMonitor.reset = () => resets.push('context');
  app.quotaMonitor.reset = () => resets.push('quota');
  for (const context of [true, false]) for (const quota of [true, false]) {
    const old = app.settings.get();
    await app.configure({ enableContextMonitor: context, enableQuotaMonitor: quota });
    assert.deepEqual(resets.splice(0), [
      ...(old.enableContextMonitor !== context ? ['context'] : []), ...(old.enableQuotaMonitor !== quota ? ['quota'] : [])
    ]);
    await app.cdp.onMetrics(id, { quotaOnly: false });
    await app.cdp.onMetrics(null, { quotaOnly: true });
    assert.deepEqual(samples.splice(0), [...(context ? ['context'] : []), ...(quota ? ['quota'] : [])]);
  }
});

test('CDP statistics reject remote origins, wrong conversations, iframe contexts and stale reinjections', async () => {
  const outputs = [];
  let href = `http://127.0.0.1:4000/c/${id}`, reads = 0, resolve;
  const hub = new CdpHub({ source: () => '', onMetrics: async () => { reads++; return { conversationId: id, state: 'live' }; } });
  hub.running = true;
  const connection = { url: 'ws://127.0.0.1:9333/page', pageUrl: href, contexts: new Set([7]), injectGeneration: 1,
    command: async (_, params) => params.expression.startsWith('({ href:') ? { result: { value: { href, conversationId: new URL(href).pathname.match(/\/c\/([^/]+)/)?.[1] } } } : outputs.push(params) };
  const event = { conversationId: id, requestId: '1' };
  await hub.metrics(connection, 7, event); assert.equal(reads, 1); assert.equal(outputs.length, 1);
  for (const location of ['https://external.example/c/' + id, 'http://127.0.0.1:4001/c/' + id, 'http://127.0.0.1:4000/c/' + otherId]) {
    href = location; connection.metricsChannels.context.at = 0; await hub.metrics(connection, 7, event);
  }
  href = connection.pageUrl; connection.metricsChannels.context.at = 0; await hub.metrics(connection, 8, event);
  assert.equal(reads, 1);
  hub.onMetrics = () => new Promise(done => { resolve = done; });
  connection.metricsChannels.context.at = 0;
  const pending = hub.metrics(connection, 7, event);
  await new Promise(done => setImmediate(done));
  connection.injectGeneration++; resolve({ conversationId: id }); await pending;
  assert.equal(outputs.length, 1);
});

test('endpoint model extracts Protobuf 1.19 responseModel separately from UI display label and rejects unsafe values', () => {
  const modelMap = new Map([['MODEL_PLACEHOLDER_M26', 'Gemini 3.8 Flash (UI)']]);
  const sample = {
    chatModel: {
      model: 'MODEL_PLACEHOLDER_M26',
      responseModel: 'gemini-3.8-flash-k',
      usage: { messageId: 'm1', responseOutputTokens: '60' },
      streamingDuration: '1.5s',
      chatStartMetadata: { contextWindowMetadata: { estimatedTokensUsed: 50, maxContextTokens: 200 } }
    }
  };
  const summary = summarizeMetadata([sample], modelMap);
  assert.equal(summary.context.model, 'Gemini 3.8 Flash (UI)');
  assert.equal(summary.context.endpointModel, 'gemini-3.8-flash-k');
  assert.equal(summary.speed.endpointModel, 'gemini-3.8-flash-k');
  assert.equal(resolveEndpointModel({ chatModel: { model: 'MODEL_PLACEHOLDER_M26' } }), null);
  assert.equal(resolveEndpointModel({ chatModel: { model: 'gemini-3.8-flash-k' } }), 'gemini-3.8-flash-k');
  assert.equal(resolveEndpointModel({ chatModel: { responseModel: 'bad\nvalue' } }), null);
  assert.equal(resolveEndpointModel({ chatModel: { responseModel: '<script>' } }), null);
});
