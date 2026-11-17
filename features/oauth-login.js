const crypto = require('node:crypto');
const http = require('node:http');

const {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchUserInfo,
  emailFromIdToken,
  resolveOAuthClient
} = require('../core/oauth');

const CALLBACK_PATH = '/oauth-callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address());
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port });
  });
}

async function closeServer(server) {
  if (!server || !server.listening) return;
  try { server.closeAllConnections?.(); } catch {}
  await new Promise(resolve => {
    server.close(() => resolve());
  }).catch(() => {});
}

async function createLoopbackListeners(handler) {
  let ipv6Server = null;
  let ipv4Server = null;
  let port = 0;

  try {
    ipv6Server = http.createServer(handler);
    const address = await listen(ipv6Server, '::1', 0);
    port = address.port;
  } catch {
    await closeServer(ipv6Server);
    ipv6Server = null;
  }

  if (ipv6Server) {
    try {
      ipv4Server = http.createServer(handler);
      await listen(ipv4Server, '127.0.0.1', port);
    } catch {
      await closeServer(ipv4Server);
      ipv4Server = null;
    }
  }

  if (!ipv6Server && !ipv4Server) {
    ipv4Server = http.createServer(handler);
    const address = await listen(ipv4Server, '127.0.0.1', 0);
    port = address.port;
  }

  const redirectUri = ipv4Server && ipv6Server
    ? `http://localhost:${port}${CALLBACK_PATH}`
    : ipv4Server
      ? `http://127.0.0.1:${port}${CALLBACK_PATH}`
      : `http://[::1]:${port}${CALLBACK_PATH}`;

  return {
    servers: [ipv4Server, ipv6Server].filter(Boolean),
    redirectUri
  };
}

function sendHtml(response, status, title, message) {
  if (response.headersSent) return;
  const color = status >= 400 ? '#dc2626' : '#059669';
  const safeTitle = String(title).replace(/[<&>"]/g, '');
  const safeMessage = String(message).replace(/[<&>"]/g, '');
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close'
  });
  response.end(`<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;padding:48px 20px;color:#334155">
  <h1 style="color:${color}">${safeTitle}</h1>
  <p>${safeMessage}</p>
  <script>setTimeout(() => window.close(), 1800)</script>
</body>
</html>`);
}

function sameState(expected, received) {
  const left = Buffer.from(text(expected));
  const right = Buffer.from(text(received));
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function parseCallbackUrl(value) {
  const raw = text(value);
  if (!raw) throw new Error('请粘贴登录成功后的完整链接');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('登录回填链接格式无效，请复制浏览器地址栏中的完整链接');
  }
  if (parsed.pathname !== CALLBACK_PATH) {
    throw new Error('登录回填链接不是有效的 OAuth 回调链接');
  }
  return parsed;
}

function callbackCode(target, callbackUrl) {
  const error = text(callbackUrl.searchParams.get('error'));
  const code = text(callbackUrl.searchParams.get('code'));
  const receivedState = callbackUrl.searchParams.get('state') || '';
  if (error) throw new Error('登录未完成，请返回应用重试');
  if (!sameState(target.stateValue, receivedState)) {
    throw new Error('登录校验失败，请重新发起登录');
  }
  if (!code) throw new Error('回填链接中没有授权结果，请复制登录成功后的完整链接');
  return code;
}

function createOAuthLogin({
  accountManager,
  host,
  events,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  clientKey = '',
  resolveClient = resolveOAuthClient
} = {}) {
  if (!accountManager || typeof accountManager.add !== 'function') {
    throw new Error('OAuth 登录缺少账号保存接口');
  }

  let flow = null;

  function snapshot(target = flow) {
    if (!target) {
      return {
        ok: true,
        state: 'idle',
        url: '',
        expiresAt: 0,
        account: null,
        error: '',
        message: ''
      };
    }
    const active = ['waiting', 'opened', 'exchanging'].includes(target.state);
    return {
      ok: target.state !== 'error',
      state: target.state,
      active,
      url: active && target.state !== 'exchanging' ? target.authUrl : '',
      expiresAt: target.expiresAt,
      account: target.account || null,
      error: target.error || '',
      message: target.message || ''
    };
  }

  async function closeListeners(target) {
    if (!target || target.listenersClosed) return;
    target.listenersClosed = true;
    clearTimeout(target.timer);
    await Promise.all(target.servers.map(server => closeServer(server)));
  }

  async function fail(target, message) {
    if (!target || target.settled) return;
    target.settled = true;
    target.state = 'error';
    target.error = text(message) || '登录失败';
    target.message = target.error;
    await closeListeners(target);
  }

  async function complete(target, code) {
    if (!target || target.settled) return;
    target.state = 'exchanging';
    target.message = '登录成功，正在保存账号…';
    try {
      const token = await exchangeAuthorizationCode({
        code,
        redirectUri: target.redirectUri,
        client: target.client,
        codeVerifier: target.codeVerifier,
        fetchImpl
      });
      let identity;
      try {
        identity = await fetchUserInfo(token.accessToken, fetchImpl);
      } catch (error) {
        const fallbackEmail = emailFromIdToken(token.idToken);
        if (!fallbackEmail) throw error;
        identity = { email: fallbackEmail, label: '' };
      }
      const account = accountManager.add({
        email: identity.email,
        label: identity.label,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiryTimestamp: token.expiryTimestamp,
        idToken: token.idToken,
        projectId: token.projectId,
        oauthClientKey: token.client.key,
        isGcpTos: token.client.isGcpTos
      });
      target.account = account;
      target.state = 'completed';
      target.message = account.hasRefreshToken
        ? `已保存账号 ${account.email}`
        : `已保存账号 ${account.email}，当前登录未返回可刷新凭据`;
      if (events?.log) {
        events.log('ACCOUNT', `网页登录已保存账号 ${account.email}`, 'tag-proxy');
      }
    } catch (error) {
      target.state = 'error';
      target.error = text(error?.message) || '登录失败';
      target.message = target.error;
    } finally {
      target.settled = true;
      await closeListeners(target);
    }
  }

  async function receive(target, request, response) {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method !== 'GET' || requestUrl.pathname !== CALLBACK_PATH) {
      sendHtml(response, 404, '地址不存在', '此地址只用于完成账号登录。');
      return;
    }
    if (!target || target !== flow || target.settled) {
      sendHtml(response, 410, '登录已结束', '请返回 Antigravity++ 重新发起登录。');
      return;
    }

    const receivedState = requestUrl.searchParams.get('state') || '';
    const error = text(requestUrl.searchParams.get('error'));
    const code = text(requestUrl.searchParams.get('code'));
    if (error) {
      sendHtml(response, 400, '登录未完成', '你取消了登录或授权请求被拒绝，请返回应用重试。');
      await fail(target, '登录未完成，请返回应用重试');
      return;
    }
    if (!sameState(target.stateValue, receivedState)) {
      sendHtml(response, 400, '登录校验失败', '登录校验信息无效，请返回应用重新发起登录。');
      await fail(target, '登录校验失败，请重新发起登录');
      return;
    }
    if (!code) {
      sendHtml(response, 400, '登录未完成', '回调中没有收到授权结果，请返回应用重试。');
      await fail(target, '回调中没有收到授权结果');
      return;
    }

    sendHtml(response, 200, '登录成功', '授权结果已收到，账号正在自动保存。你可以关闭此页面。');
    void complete(target, code);
  }

  async function completeFromCallbackUrl(callbackUrl) {
    const target = flow;
    if (!target) throw new Error('请先生成登录链接');
    if (target.state === 'exchanging') throw new Error('登录正在保存，请稍候');
    if (target.state === 'completed') return snapshot(target);
    if (target.state === 'cancelled') throw new Error('登录已取消，请重新生成登录链接');

    const parsed = parseCallbackUrl(callbackUrl);
    const code = callbackCode(target, parsed);
    if (target.settled) {
      if (target.state !== 'error') throw new Error('当前登录流程已结束，请重新生成链接');
      target.settled = false;
      target.listenersClosed = true;
      target.state = 'opened';
      target.error = '';
      target.message = '已收到回填链接，正在保存账号…';
    }
    await complete(target, code);
    return snapshot(target);
  }

  async function start(requestedClientKey = clientKey) {
    if (flow && ['waiting', 'opened', 'exchanging'].includes(flow.state)) {
      if (flow.state === 'exchanging') throw new Error('上一次登录正在保存，请稍候');
      await cancel();
    }

    const stateValue = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    let listeners;
    try {
      listeners = await createLoopbackListeners((request, response) => {
        void receive(flow, request, response);
      });
      const auth = buildAuthorizationUrl({
        redirectUri: listeners.redirectUri,
        state: stateValue,
        client: resolveClient(requestedClientKey),
        codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url')
      });
      const target = {
        state: 'waiting',
        stateValue,
        authUrl: auth.url,
        redirectUri: listeners.redirectUri,
        clientKey: auth.client.key,
        client: auth.client,
        codeVerifier,
        expiresAt: Date.now() + timeoutMs,
        servers: listeners.servers,
        timer: null,
        account: null,
        error: '',
        message: '等待你在浏览器中完成登录…',
        settled: false,
        listenersClosed: false
      };
      flow = target;
      target.timer = setTimeout(() => {
        void fail(target, '登录链接已过期，请重新生成链接');
      }, timeoutMs);
      return snapshot(target);
    } catch (error) {
      if (listeners) await Promise.all(listeners.servers.map(server => closeServer(server)));
      throw error;
    }
  }

  async function open() {
    if (!flow || !['waiting', 'opened'].includes(flow.state)) {
      throw new Error('请先生成登录链接');
    }
    if (typeof host?.open !== 'function') throw new Error('当前环境不支持打开浏览器');
    host.open(flow.authUrl);
    flow.state = 'opened';
    flow.message = '登录页面已打开，等待完成授权…';
    return snapshot(flow);
  }

  async function cancel() {
    if (!flow) return snapshot();
    if (flow.state === 'exchanging') throw new Error('登录正在保存，请稍候');
    flow.settled = true;
    flow.state = 'cancelled';
    flow.message = '登录已取消';
    await closeListeners(flow);
    flow = null;
    return snapshot();
  }

  async function close() {
    if (!flow) return;
    flow.settled = true;
    await closeListeners(flow);
    flow = null;
  }

  return {
    start,
    open,
    completeFromCallbackUrl,
    cancel,
    close,
    status: () => snapshot()
  };
}

module.exports = {
  CALLBACK_PATH,
  DEFAULT_TIMEOUT_MS,
  createOAuthLogin
};
