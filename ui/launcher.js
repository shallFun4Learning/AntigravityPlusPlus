import { api } from './api.js';
import { accountDisplayName, clearActivity, createAccountPanel, openView, recordActivity, showNotice } from './workspace.js';

const element = id => document.getElementById(id);
const consoleBox = element('consoleBox');
let phase = 'idle';
let settingsQueue = Promise.resolve();
let refreshing = false;
let stream;
let pollTimer;
let launchPending = false;
let cleanupPending = false;
let viewedTarget = 'hub';
let userSelectedTarget = false;
let sessionTarget = 'hub';
let pendingLaunchTarget = null;
let restartTarget = null;
let cdpSockets = 0;
let cdpError = '';
let dictEntries = 0;
const enhancementControls = { enableI18n: 'i18nToggle', enableContextMonitor: 'contextMonitorToggle', enableQuotaMonitor: 'quotaMonitorToggle' };
const enhancements = { enableI18n: true, enableContextMonitor: true, enableQuotaMonitor: true };
const pendingEnhancements = new Map();
let currentTargets = {};
let accountState = { accounts: [], currentByTarget: { hub: null, ide: null } };
let accountOAuthPollTimer = null;
let accountOAuthPollInFlight = false;
let accountOAuthAttempt = 0;
let accountConfirmResolver = null;
let accountRiskAcknowledged = false;
let accountRiskResolver = null;
let accountRiskSaving = false;
let accountRiskReturnFocus = null;
let switchPending = false;
let switchProgress = null;
let portDraft = false;
let savedPort = 7890;
let modalOpener = null;
let importPending = false;
const logKeys = new Set();
const accountPanel = createAccountPanel({
  onSwitch: id => runAccountAction(() => switchAccount(id)),
  onRefresh: id => runAccountAction(() => refreshAccount(id)),
  onDelete: id => runAccountAction(() => deleteAccount(id))
});

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
  const time = new Date(at || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  line.textContent = `[${time}] [${category || 'SYSTEM'}] ${message || ''}`;
  consoleBox.appendChild(line);
  while (consoleBox.children.length > 300) consoleBox.firstElementChild.remove();
  consoleBox.scrollTop = consoleBox.scrollHeight;
  recordActivity(time, category || 'SYSTEM', message || '');
}

function report(error) {
  const message = error.message || String(error);
  showNotice(message, 'error');
  appendLog('SYSTEM', message, 'tag-alert');
}

function switching() { return switchPending || switchProgress?.state === 'working'; }

function updateProxyUi(enabled) {
  const row = element('proxyPortRow');
  const badge = element('patchStatusBadge');
  const busyOrRunning = switching() || ['preparing', 'launching', 'running', 'cleaning'].includes(phase);
  if (row) row.classList.toggle('disabled', !enabled);
  document.querySelectorAll('[data-port], #customPortBtn').forEach(control => {
    control.disabled = !enabled || busyOrRunning;
  });
  if (element('proxyPortInput')) {
    element('proxyPortInput').disabled = !enabled || busyOrRunning;
  }
  if (badge) {
    badge.textContent = enabled ? '仅用于 Antigravity 进程' : '直连模式';
  }
  updatePortSelection();
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
  const selectedName = selectedControl?.dataset.name;
  element('customPortBtn').classList.toggle('active', valid && !selectedControl);
  if (state) {
    state.classList.toggle('custom', !selectedControl);
    state.classList.toggle('invalid', Boolean(value) && !valid);
    state.textContent = selectedControl
      ? `已选择 ${value}`
      : valid ? `自定义 ${value}` : '待输入有效端口';
  }
  if (hint) {
    if (!element('proxyToggle').checked) hint.textContent = '直连模式已开启。';
    else if (input.disabled) hint.textContent = '客户端结束运行后可更改端口。';
    else if (selectedName) hint.textContent = `${selectedName} 常用端口 · 也可输入自定义端口`;
    else hint.textContent = valid ? '自定义端口' : '请输入 1–65535 的整数';
  }
}

function targetLabel(target) { return target === 'ide' ? 'IDE 版' : '桌面版'; }
function clientName(target = viewedTarget) { return currentTargets[target]?.name || (target === 'ide' ? 'Antigravity IDE' : 'Antigravity'); }
function sessionInUse() { return ['running', 'preparing', 'launching', 'cleaning'].includes(phase); }
function controllingTarget() { return (switching() && switchProgress?.target) || pendingLaunchTarget || sessionTarget; }
function viewingOtherSession() { return (switching() || sessionInUse()) && controllingTarget() !== viewedTarget; }
function targetMissing() { return currentTargets[viewedTarget]?.exists === false; }
function switchBlockedReason() {
  if (targetMissing()) return `未检测到${targetLabel(viewedTarget)}，请先安装或设置路径。`;
  if (viewingOtherSession()) return `请先退出${targetLabel(controllingTarget())}，再切换${targetLabel(viewedTarget)}账号。`;
  if (['preparing', 'launching', 'cleaning'].includes(phase)) return '请等待客户端操作完成。';
  return '';
}

function applicableEnhancements() {
  return Object.keys(enhancementControls).filter(key => key !== 'enableI18n' || viewedTarget !== 'ide');
}
function updateEnhancementMonitorUi() {
  const keys = applicableEnhancements();
  const readOnly = viewingOtherSession();
  for (const [key, id] of Object.entries(enhancementControls)) {
    const available = keys.includes(key);
    element(id).checked = available && enhancements[key];
    element(id).disabled = readOnly || !available;
  }
  const master = element('enhancementMonitorToggle');
  const count = keys.filter(key => enhancements[key]).length;
  master.checked = count === keys.length;
  master.indeterminate = count > 0 && !master.checked;
  master.disabled = readOnly;
  master.title = `已开启 ${count} / ${keys.length} 项增强功能`;
  element('contextPreview').hidden = !enhancements.enableContextMonitor;
  element('quotaPreview').hidden = !enhancements.enableQuotaMonitor;
  element('emptyPreview').hidden = enhancements.enableContextMonitor || enhancements.enableQuotaMonitor;
  element('dictCountBadge').textContent = viewedTarget === 'ide' ? '仅适用于桌面版' : `${dictEntries} 个词条`;
}

function renderPhase(next) {
  phase = next;
  document.body.dataset.uiState = next;
  const busy = ['preparing', 'launching', 'cleaning'].includes(next);
  const locked = sessionInUse() || switching();
  const other = viewingOtherSession();
  const button = element('launchBtn');
  button.disabled = other || busy || switching();
  button.title = other ? `正在查看${targetLabel(viewedTarget)}设置` : next === 'running' ? '确认后重新启动客户端' : '';
  button.classList.toggle('busy', busy && !other);
  element('proxyToggle').disabled = locked;
  element('editTargetPath').disabled = locked;
  element('accountAddBtn').disabled = switching();
  element('accountImportBtn').disabled = switching() || importPending || targetMissing() || other;
  const proxyEnabled = element('proxyToggle').checked;
  updateProxyUi(proxyEnabled);
  updateEnhancementMonitorUi();
  renderTargetsUi();
  let icon = '▷', text = `启动 ${clientName()}`;
  if (other) {
    text = `启动 ${targetLabel(viewedTarget)}`;
  } else if (switching()) {
    icon = '◌'; text = '正在切换账号…';
  } else if (targetMissing() && !locked) {
    icon = '+'; text = '配置启动路径';
  } else if (busy) {
    icon = '◌';
    text = { preparing: proxyEnabled ? '正在准备代理环境…' : '正在准备启动环境…', launching: `正在启动 ${clientName()}…`, cleaning: '正在清理并重新启动…' }[next];
  } else if (next === 'running') {
    icon = '↻'; text = `重启 ${clientName()}`;
  } else if (next === 'error' && viewedTarget === sessionTarget) {
    icon = '↻'; text = '启动失败，点击重试';
  }
  element('launchIcon').textContent = icon;
  element('launchText').textContent = text;
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
  if (!visible && modal.style.display === 'none') return;
  if (visible) modalOpener = document.activeElement;
  modal.style.display = visible ? 'flex' : 'none';
  if (visible) {
    const titleEl = element('modalTargetTitle');
    const descEl = element('pathTipText');
    const input = element('customPathInput');
    const resetBtn = element('resetPathBtn');
    const errorTip = element('pathEditTip');
    const activeObj = currentTargets[viewedTarget] || {};

    if (titleEl) titleEl.textContent = customTitle || `未找到 ${clientName()}`;
    if (descEl) descEl.textContent = customDesc || `请选择或输入 ${clientName()} 的安装路径。`;
    if (input) {
      input.value = activeObj.appExe || '';
      input.focus();
    }
    if (resetBtn) resetBtn.style.display = activeObj.isCustom ? 'inline-flex' : 'none';
    if (errorTip) errorTip.style.display = 'none';
  } else modalOpener?.focus();
}

function renderTargetsUi() {
  for (const button of document.querySelectorAll('[data-target]')) {
    const target = button.dataset.target;
    const missing = currentTargets[target]?.exists === false;
    button.setAttribute('aria-pressed', String(target === viewedTarget));
    button.querySelector('small').hidden = !missing;
    button.title = `查看${targetLabel(target)}设置${missing ? '（未检测到客户端）' : ''}`;
  }
  const missing = targetMissing(), other = viewingOtherSession();
  const notice = element('targetNotice');
  notice.hidden = !missing && !other;
  notice.dataset.missing = String(missing);
  const title = missing ? `未检测到 ${clientName()}` : `正在查看 ${targetLabel(viewedTarget)}设置`;
  const hint = other ? `${targetLabel(controllingTarget())}正在使用中，可在此查看 ${targetLabel(viewedTarget)}设置。`
    : '可以先查看设置。若已安装到其他位置，请配置启动路径。';
  if (!notice.hidden) {
    if (element('targetNoticeTitle').textContent !== title) element('targetNoticeTitle').textContent = title;
    if (element('targetNoticeText').textContent !== hint) element('targetNoticeText').textContent = hint;
  }
  element('targetPathText').textContent = currentTargets[viewedTarget]?.appExe || '尚未检测到客户端路径。';
  const running = !other && phase === 'running';
  const badge = element('clientStatusBadge');
  badge.classList.toggle('active', running);
  badge.querySelector('span').textContent = running ? (cdpSockets ? '增强已连接' : '运行中') : missing ? '未检测到' : '未运行';
  badge.title = running && cdpError ? cdpError : `${targetLabel(viewedTarget)} · ${badge.querySelector('span').textContent}`;
}

function renderAccounts(nextState = accountState) {
  accountState = {
    accounts: Array.isArray(nextState?.accounts) ? nextState.accounts : [],
    currentByTarget: {
      hub: nextState?.currentByTarget?.hub || null,
      ide: nextState?.currentByTarget?.ide || null
    }
  };
  accountPanel.render({ ...accountState, target: viewedTarget, progress: switchProgress, locked: switching(), switchBlockedReason: switchBlockedReason() });
}

function renderStatus(status) {
  if (status.accountRiskAcknowledged === true) accountRiskAcknowledged = true;
  if (status.accountSwitch && status.accountSwitch.revision > (switchProgress?.revision || 0)) {
    switchProgress = status.accountSwitch;
  }
  if (status.activeTarget) {
    sessionTarget = status.activeTarget;
    if (!userSelectedTarget) viewedTarget = sessionTarget;
  }
  if (status.targets) currentTargets = status.targets;
  if (status.dictEntries !== undefined) dictEntries = status.dictEntries;
  if (status.cdpSockets !== undefined) cdpSockets = status.cdpSockets;
  if (status.cdpError !== undefined) cdpError = status.cdpError;
  if (status.oauth && element('accountForm')?.style.display !== 'none') {
    renderAccountOAuthStatus(status.oauth);
  }
  if (status.enableProxy !== undefined && element('proxyToggle')) {
    element('proxyToggle').checked = status.enableProxy;
    updateProxyUi(status.enableProxy);
  }
  if (Number.isInteger(status.port) && !portDraft) {
    savedPort = status.port;
    element('proxyPortInput').value = String(savedPort);
    updatePortSelection();
  }
  for (const key of Object.keys(enhancementControls)) {
    if (status[key] !== undefined && !pendingEnhancements.has(key)) enhancements[key] = status[key];
  }
  renderPhase((pendingLaunchTarget && status.phase === 'idle') ? phase : status.phase || phase);
  renderAccounts(status.accounts || accountState);
  if (status.version) {
    const versionNode = element('versionBadge');
    if (versionNode) {
      versionNode.textContent = `v${status.version}`;
    }
  }
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
      if (status.account?.id) accountPanel.select(status.account.id);
      renderAccounts(accounts);
      if (status.account?.email) {
        showNotice(`已添加 ${status.account.email}`);
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
      if (result.account?.id) accountPanel.select(result.account.id);
      renderAccounts(await api.accounts());
      if (result.account?.email) {
        showNotice(`已添加 ${result.account.email}`);
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
    if (form.style.display === 'none') return;
    cancelAccountOAuth();
    form.style.display = 'none';
    element('formBackdrop').style.display = 'none';
    clearAccountForm();
    element('accountLoginUrlInput').value = '';
    modalOpener?.focus();
    return;
  }
  modalOpener = document.activeElement;
  element('formBackdrop').style.display = 'flex';
  for (const details of form.querySelectorAll('details')) details.open = false;
  form.style.display = 'block';
  clearAccountForm();
  element('accountFormClose').focus();
  startAccountOAuth();
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
  if (resolver) modalOpener?.focus();
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
  modalOpener = document.activeElement;
  modal.style.display = 'flex';
  element('accountConfirmCancel').focus();
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
    accountPanel.select(result.account?.id);
    renderAccounts(result.accounts);
    showNotice(`已添加 ${body.email}`);
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
  importPending = true;
  const originalText = button?.textContent || '导入当前登录';
  if (button) {
    button.disabled = true;
    button.textContent = '读取中…';
  }
  try {
    const result = await api.importCurrentAccount(viewedTarget);
    accountPanel.select(result.account.id);
    renderAccounts(result.accounts);
    showNotice(`已导入 ${result.account.email}`);
    const source = result.source ? `（${result.source}）` : '';
    appendLog('ACCOUNT', `已导入当前登录账号 ${result.account.email}${source}`, 'tag-proxy');
  } catch (error) {
    report(error);
  } finally {
    importPending = false;
    if (button) {
      button.textContent = originalText;
      renderPhase(phase);
    }
  }
}

async function switchAccount(accountId) {
  const account = accountState.accounts.find(item => item.id === accountId);
  const target = viewedTarget;
  if (!account || switching() || switchBlockedReason() || accountState.currentByTarget[target] === accountId) return;
  const targetName = target === 'ide' ? 'IDE 版' : '桌面版';
  const original = accountState.accounts.find(item => item.id === accountState.currentByTarget[target]);
  const source = original ? `从“${accountDisplayName(original)}”` : '';
  const message = `${targetName}将${source}切换到“${account.email}”。正在运行的客户端将退出，随后使用新账号启动。请先保存工作。`;
  if (!await requestAccountConfirmation({
    title: '确认切换账号',
    message,
    confirmText: '切换并重启'
  })) return;
  if (target !== viewedTarget || switching() || switchBlockedReason()) return;
  switchPending = true;
  switchProgress = { target, accountId, state: 'working', stage: 'checking', revision: switchProgress?.revision || 0 };
  element('actionNotice').hidden = true;
  renderPhase(phase);
  renderAccounts();
  try {
    const result = await api.switchAccount({ accountId, target });
    switchProgress = { ...switchProgress, target, accountId, state: 'done', launched: result.launched };
    renderAccounts(result.accounts);
    showNotice(result.launched ? `已切换到 ${account.email}，${targetName}已启动。` : `已切换到 ${account.email}，请配置客户端路径后启动。`);
  } catch (error) {
    switchProgress = { ...switchProgress, state: 'failed', error: error.message };
    report(error);
  } finally {
    switchPending = false;
    renderPhase(phase);
    renderAccounts();
    try { renderStatus(await api.status()); } catch (error) { report(error); }
  }
}

async function refreshAccount(accountId) {
  try {
    const result = await api.refreshAccount(accountId);
    renderAccounts(result.accounts);
    showNotice(`已刷新 ${result.account.email} 的访问凭据`);
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
    showNotice(`已删除本地账号 ${account.email}`);
    appendLog('ACCOUNT', `已删除账号 ${account.email}`, 'tag-proxy');
  } catch (error) {
    report(error);
  }
}

function queueConfiguration(payload) {
  settingsQueue = settingsQueue.catch(() => {}).then(() => api.configure(payload));
  return settingsQueue;
}

async function persistProxy(target) {
  const proxyEnabled = element('proxyToggle').checked;
  if (proxyEnabled && !validatePortInput(true)) {
    throw new Error(element('portInputError').textContent || '代理端口无效');
  }
  const payload = {
    port: proxyEnabled ? Number(element('proxyPortInput').value) : savedPort,
    enableProxy: proxyEnabled
  };
  if (target) payload.targetApp = target;
  const result = await queueConfiguration(payload);
  savedPort = result.settings?.port ?? payload.port;
  if (!element('proxyToggle').checked || Number(element('proxyPortInput').value) === savedPort) {
    portDraft = false;
    element('proxyPortInput').value = String(savedPort);
    updatePortSelection();
    validatePortInput();
  }
}

async function launch() {
  if (switching() || launchPending || viewingOtherSession()) return;
  if (phase === 'running') { showProcessModal(); return; }
  if (['preparing', 'launching', 'cleaning'].includes(phase) || cleanupPending) return;
  const currentObj = currentTargets[viewedTarget] || {};
  if (!currentObj.exists) {
    showPathModal(true);
    return;
  }
  const target = viewedTarget;
  launchPending = true;
  pendingLaunchTarget = target;
  sessionTarget = target;
  renderPhase('preparing');
  try {
    await persistProxy(target);
    renderPhase('launching');
    await api.launch(target);
    renderPhase('running');
  } catch (error) {
    renderPhase('error');
    report(error);
    if (target === viewedTarget && error.code === 'PROCESS_CONFLICT') showProcessModal();
    else if (target === viewedTarget && error.code === 'TARGET_NOT_FOUND') {
      showPathModal(true, `无法启动 ${clientName()}`, error.message);
    }
  }
  finally { launchPending = false; pendingLaunchTarget = null; renderPhase(phase); renderAccounts(); }
}

function showProcessModal() {
  restartTarget = viewedTarget;
  showPathModal(false);
  modalOpener = document.activeElement;
  element('processModalTitle').textContent = `重新启动 ${clientName()}？`;
  element('processError').textContent = '';
  element('processModal').style.display = 'flex';
  element('processCancelBtn').focus();
}
function dismissProcessModal() {
  if (!cleanupPending) {
    element('processModal').style.display = 'none';
    modalOpener?.focus();
  }
}
async function cleanProcesses() {
  if (cleanupPending || restartTarget !== viewedTarget || viewingOtherSession()) return;
  cleanupPending = true;
  element('processCleanBtn').disabled = true;
  element('processCancelBtn').disabled = true;
  element('processError').textContent = '正在清理，请稍候…';
  renderPhase('cleaning');
  try {
    await settingsQueue;
    await api.cleanAndLaunch(restartTarget);
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
  if (label) label.textContent = theme === 'dark' ? '切换浅色外观' : '切换深色外观';
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
    const res = await api.browseExe(viewedTarget);
    if (res?.ok && res.path) {
      appendLog('SYSTEM', `已配置 ${clientName()} 路径: ${res.path}`, 'tag-proxy');
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
    showModalError('请输入有效的客户端路径');
    return;
  }
  try {
    const res = await api.setTargetPath({ target: viewedTarget, path });
    if (res?.ok) {
      appendLog('SYSTEM', `已保存 ${clientName()} 路径: ${res.path}`, 'tag-proxy');
      showPathModal(false);
      if (res.status) renderStatus(res.status);
    }
  } catch (err) {
    appendLog('SYSTEM', err.message, 'tag-alert');
    showModalError(err.message || '指定的文件路径不存在');
  }
}

// 恢复默认扫描路径
async function resetDefaultPath() {
  try {
    const res = await api.setTargetPath({ target: viewedTarget, path: '' });
    if (res?.ok) {
      appendLog('SYSTEM', `已恢复 ${clientName()} 默认检测路径`, 'tag-proxy');
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
  'clear-logs': () => { consoleBox.replaceChildren(); clearActivity(); }
};

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-view]');
  if (nav) {
    if (nav.dataset.view === 'accounts') void runAccountAction(() => openView('accounts'));
    else openView(nav.dataset.view);
    return;
  }
  const targetBtn = event.target.closest('[data-target]');
  if (targetBtn && !targetBtn.disabled) {
    userSelectedTarget = true;
    viewedTarget = targetBtn.dataset.target;
    renderPhase(phase);
    renderAccounts();
    return;
  }
  const control = event.target.closest('[data-action],[data-port]');
  if (!control || control.disabled) return;
  const action = control.dataset.port !== undefined ? async () => {
    portDraft = true;
    element('proxyPortInput').value = control.dataset.port;
    updatePortSelection();
    await persistProxy();
  } : actions[control.dataset.action];
  if (action) Promise.resolve().then(() => action(control)).catch(report);
});

function dismissPathModal() {
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
element('formBackdrop').addEventListener('click', event => {
  if (event.target === element('formBackdrop')) showAccountForm(false);
});
element('dismissNotice').addEventListener('click', () => { element('actionNotice').hidden = true; });
element('customPortBtn').addEventListener('click', () => {
  element('proxyPortInput').focus();
  element('proxyPortInput').select();
});
element('editTargetPath').addEventListener('click', () => showPathModal(true, '设置启动路径'));
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
const dialogDismissals = {
  accountRiskModal: () => finishAccountRiskAcknowledgment(false),
  accountConfirmModal: () => finishAccountConfirmation(false),
  formBackdrop: () => showAccountForm(false),
  processModal: dismissProcessModal,
  pathModal: dismissPathModal
};
function visibleDialog() {
  return Object.keys(dialogDismissals).map(element).find(node => node.style.display === 'flex');
}
document.addEventListener('keydown', event => {
  const dialog = visibleDialog();
  if (!dialog) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    dialogDismissals[dialog.id]();
  } else if (event.key === 'Tab') {
    const controls = [...dialog.querySelectorAll('button:enabled, input:enabled, summary')].filter(control => control.getClientRects().length);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
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

element('proxyPortInput').addEventListener('input', () => {
  portDraft = true;
  updatePortSelection();
  validatePortInput(false);
});
for (const id of ['proxyPortInput', 'proxyToggle']) {
  element(id).addEventListener('change', () => {
    updateProxyUi(element('proxyToggle').checked);
    if (!element('proxyToggle').checked || validatePortInput(true)) persistProxy().catch(report);
  });
}
function saveEnhancements(keys, enabled) {
  const patch = Object.fromEntries(keys.map(key => [key, enabled]));
  Object.assign(enhancements, patch);
  for (const key of keys) pendingEnhancements.set(key, patch);
  updateEnhancementMonitorUi();
  queueConfiguration(patch).catch(async error => {
    report(error);
    try {
      const actual = await api.status();
      for (const key of keys) if (pendingEnhancements.get(key) === patch) enhancements[key] = actual[key];
      updateEnhancementMonitorUi();
    } catch { /* The next status poll reconciles the controls. */ }
  }).finally(() => {
    for (const key of keys) if (pendingEnhancements.get(key) === patch) pendingEnhancements.delete(key);
  });
}
for (const [key, id] of Object.entries(enhancementControls)) {
  element(id).addEventListener('change', event => saveEnhancements([key], event.target.checked));
}
element('enhancementMonitorToggle').addEventListener('change', event => saveEnhancements(applicableEnhancements(), event.target.checked));

async function init() {
  applyTheme(currentTheme());
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', e => {
    try {
      if (!localStorage.getItem('easyag-theme')) applyTheme(e.matches ? 'dark' : 'light');
    } catch {}
  });
  renderStatus(await api.status());
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
