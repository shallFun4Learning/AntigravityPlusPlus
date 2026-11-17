const { readInstalledOAuthClient } = require('../adapters/desktop/oauth-client');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

const DEFAULT_CLIENT_KEY = 'antigravity_personal';
const DEFAULT_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs'
];

const verifiedSecrets = new Map();

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeKey(value) {
  return text(value).toLowerCase();
}

function environmentClient() {
  const clientId = text(process.env.ANTIGRAVITY_OAUTH_CLIENT_ID);
  const clientSecret = text(process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET);
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new Error('OAuth 客户端配置不完整，请同时配置 ANTIGRAVITY_OAUTH_CLIENT_ID 和 ANTIGRAVITY_OAUTH_CLIENT_SECRET');
  }
  return {
    key: 'environment',
    label: '自定义 OAuth 客户端',
    clientId,
    clientSecret,
    isGcpTos: process.env.ANTIGRAVITY_OAUTH_IS_GCP_TOS === '1'
  };
}

function resolveOAuthClient(requestedKey, { settings = {}, installedClient = readInstalledOAuthClient } = {}) {
  const key = normalizeKey(requestedKey);
  const configured = environmentClient();
  if (configured && (!key || key === 'environment')) return configured;

  const activeKey = key
    || normalizeKey(process.env.ANTIGRAVITY_OAUTH_CLIENT_KEY)
    || DEFAULT_CLIENT_KEY;
  if (activeKey !== DEFAULT_CLIENT_KEY) throw new Error(`未找到 OAuth 客户端配置: ${activeKey}`);
  const client = installedClient({ settings });
  return { ...client };
}

function buildAuthorizationUrl({ redirectUri, state, clientKey, client, codeChallenge } = {}) {
  const redirect = text(redirectUri);
  const csrfState = text(state);
  if (!redirect || !csrfState) throw new Error('OAuth 登录参数不完整');
  client ||= resolveOAuthClient(clientKey);
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: DEFAULT_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: csrfState
  });
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return {
    url: `${AUTH_URL}?${params.toString()}`,
    client
  };
}

async function readJsonResponse(response) {
  return response.json().catch(() => ({}));
}

async function requestToken(client, parameters, fetchImpl = globalThis.fetch) {
  const available = [client.clientSecret, ...(client.clientSecrets || [])].filter(Boolean);
  const verified = verifiedSecrets.get(client.clientId);
  const candidates = [...new Set([
    available.includes(verified) ? verified : null,
    ...available
  ].filter(Boolean))].slice(0, 8);
  if (!candidates.length) throw new Error('本机 OAuth 客户端配置不完整');
  for (let index = 0; index < candidates.length; index++) {
    const body = new URLSearchParams(parameters);
    body.set('client_id', client.clientId);
    body.set('client_secret', candidates[index]);
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const payload = await readJsonResponse(response);
    if (!response.ok && ['invalid_client', 'unauthorized_client'].includes(payload.error)
      && index + 1 < candidates.length) continue;
    if (response.ok || !['invalid_client', 'unauthorized_client'].includes(payload.error)) {
      verifiedSecrets.set(client.clientId, candidates[index]);
    }
    return { response, payload };
  }
}

async function exchangeAuthorizationCode({
  code,
  redirectUri,
  clientKey,
  client,
  codeVerifier,
  fetchImpl = globalThis.fetch
} = {}) {
  const authorizationCode = text(code);
  const redirect = text(redirectUri);
  if (!authorizationCode || !redirect) throw new Error('OAuth 回调参数不完整');
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求');
  client ||= resolveOAuthClient(clientKey);
  const parameters = {
    code: authorizationCode,
    redirect_uri: redirect,
    grant_type: 'authorization_code'
  };
  if (codeVerifier) parameters.code_verifier = codeVerifier;
  const { response, payload } = await requestToken(client, parameters, fetchImpl);
  if (!response.ok || !text(payload.access_token)) {
    throw new Error(payload.error_description || payload.error || `登录授权交换失败 (${response.status})`);
  }
  return {
    client,
    accessToken: text(payload.access_token),
    refreshToken: text(payload.refresh_token),
    idToken: text(payload.id_token),
    expiryTimestamp: Date.now() + Math.max(1, Number(payload.expires_in) || 3600) * 1000,
    projectId: text(payload.project_id)
  };
}

async function fetchUserInfo(accessToken, fetchImpl = globalThis.fetch) {
  const token = text(accessToken);
  if (!token) throw new Error('登录授权没有返回 access token');
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持网络请求');
  const response = await fetchImpl(USERINFO_URL, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const payload = await readJsonResponse(response);
  if (!response.ok || !text(payload.email)) {
    throw new Error(payload.error_description || payload.error || `读取登录账号失败 (${response.status})`);
  }
  return {
    email: text(payload.email),
    label: text(payload.name) || text(payload.given_name)
  };
}

function emailFromIdToken(idToken) {
  const token = text(idToken);
  const parts = token.split('.');
  if (parts.length < 2) return '';
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return text(payload.email || payload.emailAddress);
  } catch {
    return '';
  }
}

module.exports = {
  AUTH_URL,
  TOKEN_URL,
  USERINFO_URL,
  DEFAULT_CLIENT_KEY,
  DEFAULT_SCOPES,
  resolveOAuthClient,
  requestToken,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  fetchUserInfo,
  emailFromIdToken
};
