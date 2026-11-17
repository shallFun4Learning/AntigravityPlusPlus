import { api } from './api.js';

const element = id => document.getElementById(id);
const consoleBox = element('consoleBox');
let phase = 'idle';
let settingsQueue = Promise.resolve();
let refreshing = false;
let stream;
let pollTimer;
let launchPending = false;
let cleanupPending = false;
let activeTarget = 'hub';
let activeTargetName = 'Antigravity';
let clientRunningState = false;
let currentTargets = {};
let accountState = { accounts: [], currentByTarget: { hub: null, ide: null } };
let pathModalDismissed = false;
let accountOAuthPollTimer = null;
let accountOAuthPollInFlight = false;
let accountOAuthAttempt = 0;
let accountConfirmResolver = null;
let accountRiskAcknowledged = false;
let accountRiskResolver = null;
let accountRiskSaving = false;
let accountRiskReturnFocus = null;
const logKeys = new Set();

// Suppress the embedded browser's default menu in the launcher.
document.addEventListener('contextmenu', event => event.preventDefault());

function appendLog(category, message, cls = '', at) {
  const key = at && `${at}|${category}|${message}`;
  if (key && logKeys.has(key)) return;
  if (key) {
    logKeys.add(key);
    if (logKeys.size > 500) logKeys.delete(logKeys.values().next().value);
  }
  const line = document.createElement('div');
  line.className = 'log-line';
  if (/^tag-[a-z-]+$/.test(cls)) line.classList.add(cls);
  const time = new Date(at || Date.now()).toLocaleTimeString();
  line.textContent = `[${time}] [${category || 'SYSTEM'}] ${message || ''}`;
  consoleBox.appendChild(line);
  while (consoleBox.children.length > 300) consoleBox.firstElementChild.remove();
  consoleBox.scrollTop = consoleBox.scrollHeight;
}

function report(error) { appendLog('SYSTEM', error.message || String(error), 'tag-alert'); }

function updateProxyUi(enabled) {
  const row = element('proxyPortRow');
  const badge = element('patchStatusBadge');
  const busyOrRunning = ['preparing', 'launching', 'running', 'cleaning'].includes(phase);
  if (row) row.classList.toggle('disabled', !enabled);
  document.querySelectorAll('[data-port]').forEach(control => {
    control.disabled = !enabled || busyOrRunning;
  });
  if (element('proxyPortInput')) {
    element('proxyPortInput').disabled = !enabled || busyOrRunning;
  }
  if (badge) {
    badge.textContent = enabled ? '· 本地代理就绪' : '· 直连模式（不挂代理）';
    badge.style.color = enabled ? 'var(--green)' : 'var(--text-dark)';
  }
}

function isValidPort(value) {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535;
}

function validatePortInput(showError = false) {
  const input = element('proxyPortInput');
  const row = document.querySelector('.port-input-row');
  const error = element('portInputError');
  if (!input) return false;
  const value = input.value.trim();
  const valid = isValidPort(value);
  const visible = !valid && (showError || value.length > 0);
  const message = !value
    ? '请输入 1–65535 的端口'
    : '端口必须是 1–65535 的整数';
  if (row) row.classList.toggle('invalid', visible);
  if (error) error.textContent = visible ? message : '';
  input.setAttribute('aria-invalid', String(visible));
  return valid;
}

function updatePortSelection() {
  const input = element('proxyPortInput');
  if (!input) return;
  const value = input.value.trim();
  const valid = isValidPort(value);
  let selectedControl = null;

  document.querySelectorAll('[data-port]').forEach(control => {
    const selected = Boolean(value) && control.dataset.port === value;
    control.classList.toggle('active', selected);
    control.setAttribute('aria-pressed', String(selected));
    if (selected) selectedControl = control;
  });

  const state = element('portCurrentState');
  const hint = element('portSelectionHint');
  const selectedName = selectedControl?.querySelector('.tag-hint')?.textContent.trim();
  if (state) {
    state.classList.toggle('custom', !selectedControl);
    state.classList.toggle('invalid', Boolean(value) && !valid);
    state.textContent = selectedControl
      ? `已选择 ${value}`
      : value
        ? `自定义 ${value}`
        : '等待输入';
  }
  if (hint) {
    hint.textContent = selectedName
      ? `已选择 ${selectedName} · 也可输入自定义端口`
      : value
        ? valid ? '自定义端口 · 可输入 1–65535' : '端口范围为 1–65535'
        : '请输入 1–65535 的端口';
  }
}

function updateEnhancementMonitorUi() {
  const master = element('enhancementMonitorToggle');
  const i18n = element('i18nToggle');
  const context = element('contextMonitorToggle');
  if (!master || !i18n || !context) return;
  const i18nEnabled = i18n.checked;
  const contextEnabled = context.checked;
  master.checked = i18nEnabled && contextEnabled;
  master.indeterminate = i18nEnabled !== contextEnabled;
  master.title = master.indeterminate
    ? '总开关：界面深度汉化或 AG 内监控处于部分开启状态'
    : '总开关：同时启用或关闭界面深度汉化和 AG 内上下文、模型用量监控';
}

function renderPhase(next, targetName = activeTargetName) {
  phase = next;
  document.body.dataset.uiState = next;
  const busy = ['preparing', 'launching', 'cleaning'].includes(next);
  const locked = busy || next === 'running';
  const button = element('launchBtn');
  button.disabled = busy;
  button.title = next === 'running' ? '点击处理已有进程' : '';
  button.classList.toggle('busy', busy);
  if (element('proxyToggle')) element('proxyToggle').disabled = locked;
  document.querySelectorAll('[data-target]').forEach(control => { control.disabled = locked; });
  const proxyEnabled = element('proxyToggle') ? element('proxyToggle').checked : true;
  document.querySelectorAll('[data-port]').forEach(control => { control.disabled = locked || !proxyEnabled; });
  element('proxyPortInput').disabled = locked || !proxyEnabled;

  const currentObj = currentTargets[activeTarget] || {};
  const isMissing = !currentObj.exists && next === 'idle';

  if (isMissing) {
    element('launchIcon').textContent = '!';
    element('launchText').textContent = `请先配置 ${targetName} 路径`;
    button.style.background = 'var(--surface-subtle)';
    button.style.color = 'var(--text-dark)';
    return;
  }

  button.style.color = '';
  element('launchIcon').textContent = busy ? '◌' : next === 'running' ? '●' : next === 'error' ? '↻' : '▶';
  element('launchText').textContent = {
    preparing: proxyEnabled ? '正在准备代理环境…' : '正在准备启动环境…',
    launching: `正在启动 ${targetName}…`,
    cleaning: '正在清理并重新启动…',
    running: `${targetName} 运行中`,
    error: '启动失败，点击重试'
  }[next] || `启动 ${targetName}`;
  button.style.background = next === 'running' ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)' : '';
}


function showModalError(msg) {
  const tip = element('pathEditTip');
  const txt = element('pathErrorText') || element('pathTipText');
  if (tip) {
    tip.style.display = 'flex';
  }
  if (txt) txt.textContent = msg || '指定的文件路径不存在';
}

function showPathModal(visible, customTitle, customDesc) {
  const modal = element('pathModal');
  if (!modal) return;
  if (visible && modal.style.display === 'flex') return;
  modal.style.display = visible ? 'flex' : 'none';
  if (visible) {
    const titleEl = element('modalTargetTitle');
    const descEl = element('pathTipText');
    const input = element('customPathInput');
    const resetBtn = element('resetPathBtn');
    const errorTip = element('pathEditTip');
    const activeObj = currentTargets[activeTarget] || {};

    if (titleEl) titleEl.textContent = customTitle || `未找到 ${activeTargetName}`;
    if (descEl) descEl.textContent = customDesc || `未在默认路径检测到 ${activeTargetName}。如安装在非 C 盘，请点击“浏览”指定 .exe 文件路径：`;
    if (input) {
      input.value = activeObj.appExe || '';
      input.focus();
    }
    if (resetBtn) resetBtn.style.display = activeObj.isCustom ? 'inline-flex' : 'none';
    if (errorTip) errorTip.style.display = 'none';
  }
}

function renderTargetsUi(targets, currentActive) {
  const hubTarget = targets.hub || {};
  const ideTarget = targets.ide || {};

  element('targetHubBtn')?.classList.toggle('active', currentActive === 'hub');
  element('targetIdeBtn')?.classList.toggle('active', currentActive === 'ide');

  const hubDot = element('hubDot');
  if (hubDot) {
    hubDot.className = 'pill-dot ' + (hubTarget.isCustom ? 'custom' : (hubTarget.exists ? 'ready' : 'missing'));
    hubDot.title = hubTarget.exists ? (hubTarget.isCustom ? '已配置自定义路径' : '已就绪 (默认路径)') : '未在默认路径检测到，点击配置';
  }
  const ideDot = element('ideDot');
  if (ideDot) {
    ideDot.className = 'pill-dot ' + (ideTarget.isCustom ? 'custom' : (ideTarget.exists ? 'ready' : 'missing'));
    ideDot.title = ideTarget.exists ? (ideTarget.isCustom ? '已配置自定义路径' : '已就绪 (默认路径)') : '未在默认路径检测到，点击配置';
  }

  const activeObj = currentActive === 'ide' ? ideTarget : hubTarget;
  if (!activeObj.exists && !pathModalDismissed) {
    showPathModal(true);
  }
}

function accountDisplayName(account) {
  return account.label || account.email || '未命名账号';
}

function renderAccounts(nextState = accountState) {
  accountState = {
    accounts: Array.isArray(nextState?.accounts) ? nextState.accounts : [],
    currentByTarget: {
      hub: nextState?.currentByTarget?.hub || null,
      ide: nextState?.currentByTarget?.ide || null
    }
  };
  const list = element('accountList');
  const summary = element('accountCurrentSummary');
  if (!list) return;
  const currentId = accountState.currentByTarget[activeTarget];
  const current = accountState.accounts.find(account => account.id === currentId);
  if (summary) {
    summary.textContent = current
      ? `${activeTarget === 'ide' ? 'IDE 版' : '桌面版'}当前：${accountDisplayName(current)}`
      : `${activeTarget === 'ide' ? 'IDE 版' : '桌面版'}尚未选择当前账号`;
  }
  list.replaceChildren();
  if (!accountState.accounts.length) {
    const empty = document.createElement('div');
    empty.className = 'account-empty';
    empty.textContent = '还没有保存账号，可以先添加一个 OAuth 凭据。';
    list.appendChild(empty);
    return;
  }
  for (const account of accountState.accounts) {
    const item = document.createElement('div');
    item.className = 'account-item' + (account.id === currentId ? ' current' : '');

    const main = document.createElement('div');
    main.className = 'account-item-main';
    const title = document.createElement('div');
    title.className = 'account-item-title';
    const name = document.createElement('span');
    name.textContent = accountDisplayName(account);
    title.appendChild(name);
    if (account.id === currentId) {
      const badge = document.createElement('span');
      badge.className = 'account-current-badge';
      badge.textContent = '当前';
      title.appendChild(badge);
    }
    const email = document.createElement('span');
    email.className = 'account-item-meta';
    email.textContent = account.email || '邮箱未知';
    main.append(title, email);

    const meta = document.createElement('div');
    meta.className = 'account-item-meta';
    const tokenBadge = document.createElement('span');
    tokenBadge.className = 'account-token-badge';
    tokenBadge.textContent = account.hasRefreshToken ? '可刷新' : (account.hasAccessToken ? '仅访问令牌' : '缺少令牌');
    meta.appendChild(tokenBadge);
    if (account.tokenExpiresAt) {
      const expiry = document.createElement('span');
      expiry.textContent = `到期 ${new Date(account.tokenExpiresAt).toLocaleDateString()}`;
      meta.appendChild(expiry);
    }
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'account-item-actions';
    if (account.id !== currentId) {
      const switchButton = document.createElement('button');
      switchButton.type = 'button';
      switchButton.className = 'clean-btn';
      switchButton.textContent = '切换';
      switchButton.title = '退出当前客户端并切换到此账号';
      switchButton.addEventListener('click', () => runAccountAction(() => switchAccount(account.id)));
      actions.appendChild(switchButton);
    }
    if (account.hasRefreshToken) {
      const refreshButton = document.createElement('button');
      refreshButton.type = 'button';
      refreshButton.className = 'clean-btn';
      refreshButton.textContent = '刷新';
      refreshButton.addEventListener('click', () => runAccountAction(() => refreshAccount(account.id)));
      actions.appendChild(refreshButton);
    }
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'clean-btn danger';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', () => runAccountAction(() => deleteAccount(account.id)));
    actions.appendChild(deleteButton);

    item.append(main, actions);
    list.appendChild(item);
  }
}

function renderStatus(status) {
  if (status.accountRiskAcknowledged === true) accountRiskAcknowledged = true;
  if (status.activeTarget) {
    activeTarget = status.activeTarget;
    activeTargetName = status.targetName || (status.activeTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity');
  }
  if (status.targets) {
    currentTargets = status.targets;
    renderTargetsUi(currentTargets, activeTarget);
  }
  if (status.accounts) renderAccounts(status.accounts);
  if (status.oauth && element('accountForm')?.style.display !== 'none') {
    renderAccountOAuthStatus(status.oauth);
  }
  if (status.enableProxy !== undefined && element('proxyToggle')) {
    element('proxyToggle').checked = status.enableProxy;
    updateProxyUi(status.enableProxy);
  }
  if (status.enableI18n !== undefined && element('i18nToggle')) element('i18nToggle').checked = status.enableI18n;
  if (status.enableContextMonitor !== undefined && element('contextMonitorToggle')) {
    element('contextMonitorToggle').checked = status.enableContextMonitor;
  }
  updateEnhancementMonitorUi();
  if (status.phase && !(launchPending && status.phase === 'idle')) renderPhase(status.phase, activeTargetName);
  if (status.dictEntries !== undefined) {
    element('dictCountBadge').textContent = `· 已载入 ${status.dictEntries} 词条`;
  }
  if (status.version) {
    const versionNode = element('versionBadge');
    if (versionNode) {
      versionNode.textContent = `v${status.version}`;
    }
  }
  if (status.clientRunning !== undefined) {
    clientRunningState = Boolean(status.clientRunning);
    const badge = element('clientStatusBadge');
    badge.className = status.clientRunning ? 'status-capsule active' : 'status-capsule';
    badge.querySelector('span').textContent = status.clientRunning
      ? status.cdpSockets ? '增强已连接' : '运行中'
      : '未运行';
    badge.title = status.cdpError || (status.clientRunning ? `${activeTargetName} 正在运行` : `${activeTargetName} 未运行`);
    renderPhase(status.phase || phase, activeTargetName);
  }
}

function loadSettings(status) {
  if (status.activeTarget) {
    activeTarget = status.activeTarget;
    activeTargetName = status.targetName || (status.activeTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity');
  }
  if (status.targets) {
    currentTargets = status.targets;
  }
  if (status.accounts) renderAccounts(status.accounts);
  element('proxyPortInput').value = status.port;
  updatePortSelection();
  if (element('proxyToggle')) element('proxyToggle').checked = status.enableProxy !== false;
  element('i18nToggle').checked = status.enableI18n;
  element('contextMonitorToggle').checked = status.enableContextMonitor;
  updateEnhancementMonitorUi();
  updateProxyUi(status.enableProxy !== false);
  renderStatus(status);
}

function stopAccountOAuthPolling() {
  if (accountOAuthPollTimer) {
    clearInterval(accountOAuthPollTimer);
    accountOAuthPollTimer = null;
  }
  accountOAuthPollInFlight = false;
}

function setAccountOAuthStatus(message, kind = '') {
  const node = element('accountOauthStatus');
  if (!node) return;
  node.textContent = message || '';
  node.className = `account-oauth-status${kind ? ` ${kind}` : ''}`;
}

function renderAccountOAuthStatus(status = {}) {
  const input = element('accountLoginUrlInput');
  const openButton = element('accountOpenLink');
  const copyButton = element('accountCopyLink');
  const callbackInput = element('accountCallbackUrlInput');
  const callbackButton = element('accountCallbackFill');
  if (input && status.url) input.value = status.url;
  const state = status.state || 'idle';
  const active = ['waiting', 'opened', 'exchanging'].includes(state);
  if (openButton) openButton.disabled = !input?.value || state === 'exchanging';
  if (copyButton) copyButton.disabled = !input?.value;
  if (callbackButton) callbackButton.disabled = !callbackInput?.value.trim() || state === 'exchanging';

  const messages = {
    waiting: '登录链接已生成，点击“打开链接”完成登录。',
    opened: '登录页面已打开，完成授权后会自动保存账号。',
    exchanging: '登录成功，正在保存账号…',
    completed: status.message || '账号已保存。',
    cancelled: '登录已取消。',
    error: status.error || status.message || '登录失败，请重新生成链接。'
  };
  const kind = state === 'completed' ? 'success' : state === 'error' ? 'error' : '';
  setAccountOAuthStatus(messages[state] || '正在准备登录链接…', kind);
  return { state, active };
}

async function pollAccountOAuth(attempt) {
  if (accountOAuthPollInFlight || attempt !== accountOAuthAttempt) return;
  accountOAuthPollInFlight = true;
  try {
    const status = await api.accountOAuthStatus();
    if (attempt !== accountOAuthAttempt) return;
    const { state, active } = renderAccountOAuthStatus(status);
    if (state === 'completed') {
      stopAccountOAuthPolling();
      const accounts = await api.accounts();
      if (attempt !== accountOAuthAttempt) return;
      renderAccounts(accounts);
      if (status.account?.email) {
        appendLog('ACCOUNT', `已自动保存网页登录账号 ${status.account.email}`, 'tag-proxy');
      }
      window.setTimeout(() => {
        if (attempt === accountOAuthAttempt && element('accountForm')?.style.display !== 'none') {
          showAccountForm(false);
        }
      }, 900);
    } else if (!active && state === 'error') {
      stopAccountOAuthPolling();
    }
  } catch (error) {
    if (attempt === accountOAuthAttempt) {
      stopAccountOAuthPolling();
      setAccountOAuthStatus(error.message, 'error');
    }
  } finally {
    accountOAuthPollInFlight = false;
  }
}

async function startAccountOAuth() {
  const attempt = ++accountOAuthAttempt;
  const input = element('accountLoginUrlInput');
  const openButton = element('accountOpenLink');
  const copyButton = element('accountCopyLink');
  if (input) {
    input.value = '';
    input.placeholder = '正在生成登录链接…';
  }
  if (openButton) openButton.disabled = true;
  if (copyButton) copyButton.disabled = true;
  setAccountOAuthStatus('正在准备登录链接…');
  stopAccountOAuthPolling();
  try {
    const result = await api.startAccountOAuth();
    if (attempt !== accountOAuthAttempt || element('accountForm')?.style.display === 'none') {
      await api.cancelAccountOAuth().catch(() => {});
      return;
    }
    if (input) {
      input.value = result.url || '';
      input.placeholder = '登录链接暂不可用';
    }
    renderAccountOAuthStatus(result);
    accountOAuthPollTimer = setInterval(() => { void pollAccountOAuth(attempt); }, 800);
    void pollAccountOAuth(attempt);
  } catch (error) {
    if (attempt === accountOAuthAttempt) {
      stopAccountOAuthPolling();
      setAccountOAuthStatus(error.message, 'error');
      report(error);
    }
  }
}

async function openAccountOAuth() {
  const button = element('accountOpenLink');
  if (button?.disabled) return;
  button.disabled = true;
  try {
    const result = await api.openAccountOAuth();
    renderAccountOAuthStatus(result);
  } catch (error) {
    setAccountOAuthStatus(error.message, 'error');
    report(error);
  } finally {
    if (element('accountForm')?.style.display !== 'none') {
      button.disabled = !element('accountLoginUrlInput')?.value;
    }
  }
}

async function copyAccountOAuth() {
  const input = element('accountLoginUrlInput');
  const url = input?.value?.trim();
  if (!url) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      input.focus();
      input.select();
      if (!document.execCommand('copy')) throw new Error('当前环境不支持复制');
      input.setSelectionRange(0, 0);
    }
    setAccountOAuthStatus('登录链接已复制，可以粘贴到浏览器中打开。', 'success');
  } catch (error) {
    setAccountOAuthStatus('复制失败，请选中链接后手动复制。', 'error');
    report(error);
  }
}

async function completeAccountOAuthFromUrl() {
  const input = element('accountCallbackUrlInput');
  const button = element('accountCallbackFill');
  const callbackUrl = input?.value?.trim();
  if (!callbackUrl || button?.disabled) return;
  const attempt = ++accountOAuthAttempt;
  stopAccountOAuthPolling();
  if (button) button.disabled = true;
  setAccountOAuthStatus('正在使用回填链接保存账号…');
  try {
    const result = await api.completeAccountOAuth(callbackUrl);
    if (attempt !== accountOAuthAttempt) return;
    renderAccountOAuthStatus(result);
    if (result.state === 'completed') {
      renderAccounts(await api.accounts());
      if (result.account?.email) {
        appendLog('ACCOUNT', `已通过回填链接保存网页登录账号 ${result.account.email}`, 'tag-proxy');
      }
      window.setTimeout(() => {
        if (attempt === accountOAuthAttempt && element('accountForm')?.style.display !== 'none') {
          showAccountForm(false);
        }
      }, 900);
    }
  } catch (error) {
    if (attempt === accountOAuthAttempt) {
      setAccountOAuthStatus(error.message, 'error');
      report(error);
    }
  } finally {
    if (attempt === accountOAuthAttempt && element('accountForm')?.style.display !== 'none') {
      const state = element('accountOauthStatus')?.classList.contains('error') ? 'error' : '';
      if (button) button.disabled = !input?.value.trim() || state === 'exchanging';
    }
  }
}

function cancelAccountOAuth() {
  stopAccountOAuthPolling();
  ++accountOAuthAttempt;
  void api.cancelAccountOAuth().catch(() => {});
}

function showAccountForm(visible) {
  const form = element('accountForm');
  if (!form) return;
  if (!visible) {
    cancelAccountOAuth();
    form.style.display = 'none';
    return;
  }
  form.style.display = 'block';
  clearAccountForm();
  if (visible) {
    element('accountFormError').textContent = '';
    startAccountOAuth();
  }
}

function clearAccountForm() {
  for (const id of ['accountEmailInput', 'accountLabelInput', 'accountAccessTokenInput', 'accountRefreshTokenInput', 'accountExpiryInput', 'accountCallbackUrlInput']) {
    const input = element(id);
    if (input) input.value = '';
  }
  element('accountFormError').textContent = '';
}

function requestAccountRiskAcknowledgment() {
  if (accountRiskAcknowledged) return Promise.resolve(true);
  if (accountRiskResolver) return Promise.resolve(false);
  const modal = element('accountRiskModal');
  const checkbox = element('accountRiskCheckbox');
  if (!modal || !checkbox) return Promise.resolve(false);
  accountRiskReturnFocus = document.activeElement;
  checkbox.checked = false;
  element('accountRiskAccept').disabled = true;
  element('accountRiskError').hidden = true;
  modal.style.display = 'flex';
  const result = new Promise(resolve => { accountRiskResolver = resolve; });
  checkbox.focus();
  return result;
}

function finishAccountRiskAcknowledgment(accepted) {
  if (accountRiskSaving) return;
  const resolve = accountRiskResolver;
  accountRiskResolver = null;
  element('accountRiskModal').style.display = 'none';
  const focusTarget = accountRiskReturnFocus?.isConnected ? accountRiskReturnFocus : element('accountAddBtn');
  accountRiskReturnFocus = null;
  focusTarget?.focus();
  resolve?.(accepted);
}

async function acceptAccountRisk() {
  const checkbox = element('accountRiskCheckbox');
  if (!accountRiskResolver || accountRiskSaving || !checkbox?.checked) return;
  accountRiskSaving = true;
  const button = element('accountRiskAccept');
  const errorNode = element('accountRiskError');
  const modal = element('accountRiskModal');
  button.disabled = true;
  button.textContent = '正在保存…';
  checkbox.disabled = true;
  element('accountRiskClose').disabled = true;
  element('accountRiskCancel').disabled = true;
  errorNode.hidden = true;
  modal.setAttribute('aria-busy', 'true');
  try {
    await api.configure({ accountRiskAcknowledged: true });
    accountRiskAcknowledged = true;
  } catch (error) {
    errorNode.textContent = `确认状态未能保存，请重试：${error.message}`;
    errorNode.hidden = false;
  } finally {
    accountRiskSaving = false;
    button.textContent = '确认并继续';
    button.disabled = !checkbox.checked;
    checkbox.disabled = false;
    element('accountRiskClose').disabled = false;
    element('accountRiskCancel').disabled = false;
    modal.removeAttribute('aria-busy');
  }
  if (accountRiskAcknowledged) finishAccountRiskAcknowledgment(true);
}

async function runAccountAction(action) {
  if (!await requestAccountRiskAcknowledgment()) return;
  try { await action(); }
  catch (error) { report(error); }
}

function finishAccountConfirmation(confirmed) {
  const resolver = accountConfirmResolver;
  accountConfirmResolver = null;
  const modal = element('accountConfirmModal');
  if (modal) modal.style.display = 'none';
  resolver?.(confirmed);
}

function requestAccountConfirmation({ title, message, confirmText = '确认', danger = false }) {
  const modal = element('accountConfirmModal');
  const titleNode = element('accountConfirmTitle');
  const messageNode = element('accountConfirmMessage');
  const confirmButton = element('accountConfirmOk');
  if (!modal || !titleNode || !messageNode || !confirmButton) return Promise.resolve(false);
  if (accountConfirmResolver) finishAccountConfirmation(false);
  titleNode.textContent = title;
  messageNode.textContent = message;
  confirmButton.textContent = confirmText;
  confirmButton.classList.toggle('account-confirm-danger', danger);
  modal.style.display = 'flex';
  confirmButton.focus();
  return new Promise(resolve => { accountConfirmResolver = resolve; });
}

async function saveAccount() {
  const errorNode = element('accountFormError');
  const button = element('accountFormSave');
  const body = {
    email: element('accountEmailInput').value.trim(),
    label: element('accountLabelInput').value.trim(),
    accessToken: element('accountAccessTokenInput').value.trim(),
    refreshToken: element('accountRefreshTokenInput').value.trim(),
    expiryTimestamp: element('accountExpiryInput').value.trim()
  };
  if (!body.email || (!body.accessToken && !body.refreshToken)) {
    errorNode.textContent = '请填写邮箱，并至少提供一个 access token 或 refresh token。';
    return;
  }
  button.disabled = true;
  errorNode.textContent = '';
  try {
    const result = await api.addAccount(body);
    renderAccounts(result.accounts);
    appendLog('ACCOUNT', `已保存账号 ${body.email}`, 'tag-proxy');
    clearAccountForm();
    showAccountForm(false);
  } catch (error) {
    errorNode.textContent = error.message;
    report(error);
  } finally {
    button.disabled = false;
  }
}

async function importCurrentAccount() {
  const button = element('accountImportBtn');
  if (button?.disabled) return;
  const originalText = button?.textContent || '导入当前登录';
  if (button) {
    button.disabled = true;
    button.textContent = '读取中…';
  }
  try {
    const result = await api.importCurrentAccount(activeTarget);
    renderAccounts(result.accounts);
    const source = result.source ? `（${result.source}）` : '';
    appendLog('ACCOUNT', `已导入当前登录账号 ${result.account.email}${source}`, 'tag-proxy');
  } catch (error) {
    report(error);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function switchAccount(accountId) {
  const account = accountState.accounts.find(item => item.id === accountId);
  if (!account) return;
  const targetName = activeTarget === 'ide' ? 'IDE 版' : '桌面版';
  const message = clientRunningState || phase !== 'idle'
    ? `切换到“${accountDisplayName(account)}”会退出当前 ${targetName}，写入新凭据并重新启动。请先保存工作，是否继续？`
    : `是否将 ${targetName} 切换到“${accountDisplayName(account)}”？`;
  if (!await requestAccountConfirmation({
    title: '确认切换账号',
    message,
    confirmText: '确认切换'
  })) return;
  try {
    const result = await api.switchAccount({ accountId, target: activeTarget });
    renderAccounts(result.accounts);
    renderStatus(await api.status());
    appendLog('ACCOUNT', result.launched
      ? `已切换到 ${account.email}，${targetName}正在重新启动`
      : `已切换到 ${account.email}，请手动启动 ${targetName}`, 'tag-proxy');
  } catch (error) {
    report(error);
    renderAccounts((await api.accounts()).accounts);
  }
}

async function refreshAccount(accountId) {
  try {
    const result = await api.refreshAccount(accountId);
    renderAccounts(result.accounts);
    appendLog('ACCOUNT', `已刷新 ${result.account.email} 的访问凭据`, 'tag-proxy');
  } catch (error) {
    report(error);
  }
}

async function deleteAccount(accountId) {
  const account = accountState.accounts.find(item => item.id === accountId);
  if (!account) return;
  if (!await requestAccountConfirmation({
    title: '确认删除账号',
    message: `确定删除账号“${accountDisplayName(account)}”吗？本地保存的凭据也会一并删除。`,
    confirmText: '确认删除',
    danger: true
  })) return;
  try {
    const result = await api.deleteAccount(accountId);
    renderAccounts(result.accounts);
    appendLog('ACCOUNT', `已删除账号 ${account.email}`, 'tag-proxy');
  } catch (error) {
    report(error);
  }
}

function persistSettings() {
  if (!validatePortInput(true)) {
    return Promise.reject(new Error(element('portInputError')?.textContent || '代理端口无效'));
  }
  const payload = {
    port: Number(element('proxyPortInput').value),
    enableProxy: element('proxyToggle') ? element('proxyToggle').checked : true,
    enableI18n: element('i18nToggle').checked,
    enableContextMonitor: element('contextMonitorToggle').checked,
    targetApp: activeTarget
  };
  settingsQueue = settingsQueue.catch(() => {}).then(() => api.configure(payload));
  return settingsQueue;
}

async function launch() {
  if (phase === 'running') { showProcessModal(); return; }
  if (['preparing', 'launching', 'cleaning'].includes(phase) || cleanupPending) return;
  const currentObj = currentTargets[activeTarget] || {};
  if (!currentObj.exists) {
    pathModalDismissed = false;
    showPathModal(true);
    report(new Error(`未找到 ${activeTargetName}，请先指定 .exe 路径完成配置`));
    return;
  }
  launchPending = true;
  renderPhase('preparing');
  try {
    await persistSettings();
    renderPhase('launching');
    await api.launch();
    renderPhase('running');
  } catch (error) {
    renderPhase('error');
    report(error);
    if (error.code === 'PROCESS_CONFLICT') showProcessModal();
    else if (error.code === 'TARGET_NOT_FOUND') {
      pathModalDismissed = false;
      showPathModal(true, `无法启动 ${activeTargetName}`, error.message);
    }
  }
  finally { launchPending = false; }
}

function showProcessModal() {
  showPathModal(false);
  element('processModalTitle').textContent = `检测到已有 ${activeTargetName} 进程`;
  element('processError').textContent = '';
  element('processModal').style.display = 'flex';
  element('processCancelBtn').focus();
}
function dismissProcessModal() {
  if (!cleanupPending) element('processModal').style.display = 'none';
}
async function cleanProcesses() {
  if (cleanupPending) return;
  cleanupPending = true;
  element('processCleanBtn').disabled = true;
  element('processCancelBtn').disabled = true;
  element('processError').textContent = '正在清理，请稍候…';
  renderPhase('cleaning');
  try {
    await settingsQueue;
    await api.cleanAndLaunch();
    element('processModal').style.display = 'none';
    renderPhase('running');
  } catch (error) {
    report(error);
    element('processError').textContent = error.message;
    renderPhase('error');
  } finally {
    cleanupPending = false;
    element('processCleanBtn').disabled = false;
    element('processCancelBtn').disabled = false;
  }
}

async function checkUpdate() {
  const btn = element('updateBtn');
  const actionLabel = element('updateActionText') || btn;
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  if (actionLabel) actionLabel.textContent = '↻ 检查中…';
  try {
    const result = await api.checkUpdate();
    appendLog('SYSTEM', result.message || '检查更新完成', result.updated ? 'tag-proxy' : 'tag-aa');
    if (result.status) renderStatus(result.status);
    if (actionLabel) actionLabel.textContent = result.updated ? '✓ 已更新' : '↻ 检查更新';
  } catch (error) {
    report(error);
    if (actionLabel) actionLabel.textContent = '↻ 重试';
  } finally {
    setTimeout(() => { if (btn) btn.disabled = false; }, 1200);
  }
}

function currentTheme() {
  const root = document.documentElement;
  return root.dataset.theme === 'light' || root.dataset.theme === 'dark'
    ? root.dataset.theme
    : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function applyTheme(theme, save = false) {
  document.documentElement.dataset.theme = theme;
  if (save) {
    try { localStorage.setItem('easyag-theme', theme); } catch {}
    void api.setTheme(theme).catch(() => {});
  }
  const btn = element('themeToggleBtn');
  const label = element('themeToggleText');
  if (label) label.textContent = theme === 'dark' ? '🌙' : '☀️';
  if (btn) btn.title = theme === 'dark' ? '当前外观: 深色 (点击切换浅色)' : '当前外观: 浅色 (点击切换深色)';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next, true);
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(consoleBox.innerText);
    appendLog('SYSTEM', '日志已复制', 'tag-proxy');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(consoleBox);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    appendLog('SYSTEM', '已选中日志，可手动复制', 'tag-warn');
  }
}

// 浏览选择可执行文件
async function browseTargetExe() {
  const btn = element('browseExeBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await api.browseExe(activeTarget);
    if (res?.ok && res.path) {
      appendLog('SYSTEM', `已配置 ${activeTargetName} 路径: ${res.path}`, 'tag-proxy');
      pathModalDismissed = false;
      showPathModal(false);
      if (res.status) renderStatus(res.status);
    }
  } catch (err) {
    report(err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 保存手动输入的路径
async function saveCustomPath() {
  const input = element('customPathInput');
  const path = input ? input.value.trim() : '';
  if (!path) {
    showModalError('请输入有效的 .exe 文件路径');
    return;
  }
  try {
    const res = await api.setTargetPath({ target: activeTarget, path });
    if (res?.ok) {
      appendLog('SYSTEM', `已保存 ${activeTargetName} 路径: ${res.path}`, 'tag-proxy');
      pathModalDismissed = false;
      showPathModal(false);
      if (res.status) renderStatus(res.status);
    }
  } catch (err) {
    report(err);
    showModalError(err.message || '指定的文件路径不存在');
  }
}

// 恢复默认扫描路径
async function resetDefaultPath() {
  try {
    const res = await api.setTargetPath({ target: activeTarget, path: '' });
    if (res?.ok) {
      appendLog('SYSTEM', `已恢复 ${activeTargetName} 默认检测路径`, 'tag-proxy');
      pathModalDismissed = false;
      showPathModal(false);
      const input = element('customPathInput');
      if (input) input.value = '';
      if (res.status) renderStatus(res.status);
    }
  } catch (err) {
    report(err);
  }
}

const actions = {
  'dismiss-process': dismissProcessModal,
  'clean-process': cleanProcesses,
  launch,
  hide: () => api.hide(),
  'toggle-theme': toggleTheme,
  'check-update': checkUpdate,
  'copy-logs': copyLogs,
  'clear-logs': () => { consoleBox.replaceChildren(); }
};

document.addEventListener('click', event => {
  const targetBtn = event.target.closest('[data-target]');
  if (targetBtn && !targetBtn.disabled) {
    const nextTarget = targetBtn.dataset.target;
    if (nextTarget && nextTarget !== activeTarget) {
      activeTarget = nextTarget;
      activeTargetName = nextTarget === 'ide' ? 'Antigravity IDE' : 'Antigravity';
      pathModalDismissed = false;
      showPathModal(false);
      element('targetHubBtn')?.classList.toggle('active', activeTarget === 'hub');
      element('targetIdeBtn')?.classList.toggle('active', activeTarget === 'ide');
      renderTargetsUi(currentTargets, activeTarget);
      renderPhase(phase, activeTargetName);
      renderAccounts(accountState);
      api.configure({ targetApp: nextTarget }).then(res => {
        if (res?.targetName) activeTargetName = res.targetName;
        renderPhase(phase, activeTargetName);
      }).catch(report);
    }
    return;
  }
  const control = event.target.closest('[data-action],[data-port]');
  if (!control || control.disabled) return;
  const action = control.dataset.port !== undefined ? async () => {
    element('proxyPortInput').value = control.dataset.port;
    updatePortSelection();
    await persistSettings();
  } : actions[control.dataset.action];
  if (action) Promise.resolve().then(() => action(control)).catch(report);
});

function dismissPathModal() {
  pathModalDismissed = true;
  showPathModal(false);
}

for (const id of ['modalCloseBtn', 'modalCancelBtn']) {
  element(id)?.addEventListener('click', dismissPathModal);
}
element('accountAddBtn')?.addEventListener('click', () => runAccountAction(() => showAccountForm(true)));
element('accountImportBtn')?.addEventListener('click', () => runAccountAction(importCurrentAccount));
element('accountRiskCheckbox')?.addEventListener('change', event => {
  element('accountRiskAccept').disabled = accountRiskSaving || !event.target.checked;
});
element('accountRiskAccept')?.addEventListener('click', acceptAccountRisk);
for (const id of ['accountRiskClose', 'accountRiskCancel']) {
  element(id)?.addEventListener('click', () => finishAccountRiskAcknowledgment(false));
}
element('accountRiskModal')?.addEventListener('click', event => {
  if (event.target === element('accountRiskModal')) finishAccountRiskAcknowledgment(false);
});
element('accountFormClose')?.addEventListener('click', () => showAccountForm(false));
element('accountFormCancel')?.addEventListener('click', () => showAccountForm(false));
element('accountOpenLink')?.addEventListener('click', openAccountOAuth);
element('accountCopyLink')?.addEventListener('click', copyAccountOAuth);
element('accountCallbackFill')?.addEventListener('click', completeAccountOAuthFromUrl);
element('accountFormSave')?.addEventListener('click', saveAccount);
element('accountConfirmClose')?.addEventListener('click', () => finishAccountConfirmation(false));
element('accountConfirmCancel')?.addEventListener('click', () => finishAccountConfirmation(false));
element('accountConfirmOk')?.addEventListener('click', () => finishAccountConfirmation(true));
element('accountCallbackUrlInput')?.addEventListener('input', event => {
  const button = element('accountCallbackFill');
  if (button) button.disabled = !event.target.value.trim();
});
element('accountCallbackUrlInput')?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    completeAccountOAuthFromUrl();
  }
});
element('processModal')?.addEventListener('click', event => {
  if (event.target === element('processModal')) dismissProcessModal();
});
element('accountConfirmModal')?.addEventListener('click', event => {
  if (event.target === element('accountConfirmModal')) finishAccountConfirmation(false);
});
element('pathModal')?.addEventListener('click', event => {
  if (event.target === element('pathModal')) dismissPathModal();
});
document.addEventListener('keydown', event => {
  if (accountRiskResolver) {
    if (event.key === 'Escape') {
      event.preventDefault();
      finishAccountRiskAcknowledgment(false);
    } else if (event.key === 'Tab') {
      const controls = [...element('accountRiskModal').querySelectorAll('button:enabled, input:enabled')];
      const index = controls.indexOf(document.activeElement);
      event.preventDefault();
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
    }
    return;
  }
  if (event.key === 'Escape') {
    dismissPathModal();
    dismissProcessModal();
    showAccountForm(false);
    finishAccountConfirmation(false);
  }
});

element('browseExeBtn')?.addEventListener('click', browseTargetExe);
element('savePathBtn')?.addEventListener('click', saveCustomPath);
element('resetPathBtn')?.addEventListener('click', resetDefaultPath);
element('customPathInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    saveCustomPath();
  }
});

element('proxyPortInput').addEventListener('input', event => {
  event.target.value = event.target.value.replace(/\D/g, '');
  updatePortSelection();
  validatePortInput(false);
});
for (const id of ['proxyPortInput', 'proxyToggle', 'i18nToggle', 'contextMonitorToggle', 'enhancementMonitorToggle']) {
  element(id)?.addEventListener('change', () => {
    if (id === 'proxyToggle') updateProxyUi(element('proxyToggle').checked);
    if (id === 'enhancementMonitorToggle') {
      const enabled = element('enhancementMonitorToggle').checked;
      element('i18nToggle').checked = enabled;
      element('contextMonitorToggle').checked = enabled;
    }
    updateEnhancementMonitorUi();
    persistSettings().catch(report);
  });
}

async function init() {
  applyTheme(currentTheme());
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', e => {
    try {
      if (!localStorage.getItem('easyag-theme')) applyTheme(e.matches ? 'dark' : 'light');
    } catch {}
  });
  loadSettings(await api.status());
  for (const item of await api.logs()) appendLog(item.category, item.message, item.cls, item.at);
  stream = new EventSource('/api/events');
  stream.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      renderStatus(message);
      if (message.category) appendLog(message.category, message.message, message.cls, message.at);
    } catch (error) { report(error); }
  };
  pollTimer = setInterval(async () => {
    if (refreshing) return;
    refreshing = true;
    try { renderStatus(await api.status()); }
    catch { /* EventSource and the next poll reconnect without ending the backend session. */ }
    finally { refreshing = false; }
  }, 3000);
}

window.addEventListener('pagehide', () => { clearInterval(pollTimer); stream?.close(); });
init().catch(error => { renderPhase('error'); report(error); });
