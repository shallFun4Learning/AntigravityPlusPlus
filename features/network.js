const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function headerObject(input) {
  const result = {};
  if (!input) return result;
  if (typeof input.forEach === 'function') {
    input.forEach((value, key) => {
      result[String(key).toLowerCase()] = String(value);
    });
    return result;
  }
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    result[String(key).toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : String(value);
  }
  return result;
}

function bodyBuffer(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  throw new Error('代理网络请求不支持当前请求体类型');
}

function responseFrom(statusCode, headers, body, url) {
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    normalizedHeaders[key.toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : String(value);
  }
  const bytes = Buffer.from(body || []);
  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    url,
    headers: {
      get(name) {
        return normalizedHeaders[String(name).toLowerCase()] ?? null;
      }
    },
    async text() {
      return bytes.toString('utf8');
    },
    async json() {
      return JSON.parse(bytes.toString('utf8'));
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

function readResponse(response, maxBytes = MAX_RESPONSE_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    response.on('data', chunk => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        response.destroy(new Error('代理网络响应超出安全上限'));
        fail(new Error('代理网络响应超出安全上限'));
        return;
      }
      chunks.push(bytes);
    });
    response.once('end', () => {
      if (settled) return;
      settled = true;
      resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      });
    });
    response.once('error', fail);
  });
}

function proxyPortValue(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('代理端口必须是 1–65535 的整数');
  }
  return value;
}

function proxyFailure(error, port, targetUrl) {
  if (error?.code === 'ECONNREFUSED' || error?.code === 'EHOSTUNREACH' || error?.code === 'ENETUNREACH') {
    return new Error(`无法连接本地代理 127.0.0.1:${port}，请确认代理已启动（请求 ${new URL(targetUrl).hostname}）`, { cause: error });
  }
  if (error?.code === 'ETIMEDOUT' || /超时/.test(String(error?.message || ''))) {
    return new Error(`本地代理请求超时（127.0.0.1:${port}）`, { cause: error });
  }
  return error instanceof Error
    ? error
    : new Error(String(error || '代理网络请求失败'));
}

function requestViaHttpProxy(targetUrl, options = {}, proxyPort, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return Promise.reject(new Error(`代理网络请求不支持 ${parsed.protocol}`));
  }
  const port = proxyPortValue(proxyPort);
  const method = String(options.method || 'GET').toUpperCase();
  const body = bodyBuffer(options.body);
  const headers = headerObject(options.headers);
  if (!headers.host) headers.host = parsed.host;
  if (body && !headers['content-length']) headers['content-length'] = String(body.length);
  if (!headers.connection) headers.connection = 'close';
  if (options.signal?.aborted) return Promise.reject(new Error('网络请求已取消'));

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(proxyFailure(error, port, targetUrl));
    };
    const complete = response => {
      if (settled) return;
      settled = true;
      resolve(responseFrom(response.statusCode, response.headers, response.body, targetUrl));
    };
    const send = (request, label) => {
      request.setTimeout(timeoutMs, () => request.destroy(new Error(`${label}超时`)));
      request.once('error', fail);
      if (body) request.write(body);
      request.end();
    };

    if (parsed.protocol === 'http:') {
      const request = http.request({
        hostname: '127.0.0.1',
        port,
        method,
        path: parsed.toString(),
        headers,
        agent: false
      }, response => {
        readResponse(response).then(complete, fail);
      });
      send(request, '代理请求');
      return;
    }

    const connectRequest = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'CONNECT',
      path: `${parsed.hostname}:${parsed.port || 443}`,
      agent: false
    });
    connectRequest.setTimeout(timeoutMs, () => connectRequest.destroy(new Error('代理隧道握手超时')));
    connectRequest.once('error', fail);
    connectRequest.once('connect', (connectResponse, socket) => {
      if (connectResponse.statusCode !== 200) {
        connectResponse.resume();
        socket.destroy();
        fail(new Error(`代理隧道握手失败 (${connectResponse.statusCode || 0})`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: parsed.hostname
      });
      tlsSocket.once('error', fail);
      const request = https.request({
        hostname: parsed.hostname,
        port: parsed.port || 443,
        method,
        path: `${parsed.pathname || '/'}${parsed.search}`,
        headers,
        createConnection: () => tlsSocket
      }, response => {
        readResponse(response).then(complete, fail);
      });
      send(request, 'HTTPS 代理请求');
    });
    connectRequest.end();
  });
}

function isLoopbackUrl(targetUrl) {
  try {
    return LOOPBACK_HOSTS.has(new URL(targetUrl).hostname);
  } catch {
    return false;
  }
}

function createProxyFetch({
  settings,
  directFetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof directFetch !== 'function') throw new Error('当前运行环境不支持网络请求');
  return (targetUrl, options = {}) => {
    const current = typeof settings?.get === 'function' ? settings.get() : {};
    if (!current.enableProxy || isLoopbackUrl(targetUrl)) {
      return directFetch(targetUrl, options);
    }
    return requestViaHttpProxy(targetUrl, options, current.port, timeoutMs);
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  createProxyFetch,
  isLoopbackUrl,
  requestViaHttpProxy
};
