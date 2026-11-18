const fs = require('node:fs');
const path = require('node:path');
const { createSettings, assertLaunchSettingsMutable } = require('../core/settings');
const { AccountStore } = require('../core/accounts');
const { resolveOAuthClient } = require('../core/oauth');
const { createAccountManager } = require('../core/account-manager');
const { Events } = require('../core/events');
const { Session } = require('../core/session');
const { writeJson } = require('../core/storage');
const { loadDictionary } = require('../features/i18n');
const { Updater } = require('../features/updater');
const { CdpHub } = require('../adapters/desktop/cdp');
const { rendererSource } = require('../adapters/desktop/renderer');
const { createDesktopAdapter } = require('../adapters/desktop');
const { createHost } = require('./host');
const { createApi } = require('./api');
const { LanguageService } = require('../adapters/desktop/language-service');
const { readCurrentCredentials } = require('../features/antigravity-credentials');
const { ContextMonitor } = require('../features/context-monitor');
const { QuotaMonitor } = require('../features/quota-monitor');
const { createProxyFetch } = require('../features/network');
const { createOAuthLogin } = require('../features/oauth-login');

async function readCurrentIdentity({ target, targetInfo }) {
  const client = new LanguageService({
    profile: targetInfo?.profile,
    target
  });
  const result = await client.call('GetUserStatus');
  const email = result?.userStatus?.email;
  if (typeof email !== 'string' || !email.trim()) {
    throw new Error('Antigravity 当前登录状态没有返回邮箱');
  }
  return email.trim();
}

function createApplication({ rootDir, dataDir, native = false, testMode = false, fetchBytes, fetchImpl, onClose = () => {} }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const events = new Events(dataDir);
  const settings = createSettings(path.join(dataDir, 'settings.json'));
  const resolveAccountClient = key => resolveOAuthClient(key, { settings: settings.get() });
  const networkFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : createProxyFetch({ settings });
  const desktop = createDesktopAdapter(testMode);
  let dictionary = loadDictionary(rootDir, dataDir);
  const host = createHost({ native, testMode, events });
  const languageService = new LanguageService({ profile: desktop.profile });
  const contextMonitor = new ContextMonitor(languageService);
  const quotaMonitor = new QuotaMonitor(languageService);
  const accountStore = new AccountStore(dataDir);
  let session;
  let accountManager;
  let oauthLogin;
  let lastStatus = '';
  const cdp = new CdpHub({
    profile: desktop.profile,
    source: (binding, target) => rendererSource(dictionary, settings.get(), binding, target),
    onMetrics: async (id, { quotaOnly, forceQuota } = {}) => {
      const current = settings.get();
      const running = session?.phase === 'running' && !testMode;
      if (quotaOnly) {
        const quota = running && current.enableQuotaMonitor
          ? await quotaMonitor.sample(forceQuota)
          : { state: 'unavailable', source: null, groups: [] };
        return { conversationId: null, sampledAt: Date.now(), quota };
      }
      if (running && current.enableContextMonitor && id) return contextMonitor.sample(id);
      return { conversationId: id, state: 'unavailable', context: null, speed: null };
    },
    onStop: () => {
      contextMonitor.reset();
      quotaMonitor.reset();
      languageService.reset();
    },
    onStatus: status => {
      const key = JSON.stringify([status.cdpSockets, status.cdpTargets, status.cdpError]);
      if (key === lastStatus) return;
      lastStatus = key;
      events.publish({ status: status.cdpSockets ? '增强功能已连接' : '等待连接', ...session.snapshot(), ...status });
    }
  });
  session = new Session({ settings, desktop, cdp, events, host, testMode, onStart: ({ target, pid }) => {
    languageService.reset();
    languageService.profile = target.profile;
    languageService.target = target.id;
    languageService.parentPid = pid;
    contextMonitor.reset();
    quotaMonitor.reset();
  } });
  const updater = new Updater({
    rootDir, dataDir, settings, events,
    ...(fetchBytes ? { fetchBytes } : {}),
    onDictionaryUpdated: async () => {
      dictionary = loadDictionary(app.rootDir, dataDir);
      await cdp.refresh();
      const count = Object.keys(dictionary).length;
      events.publish({ dictEntries: count, ...updater.currentState() });
      return count;
    },
    onRuntimeUpdated: async nextRoot => {
      app.rootDir = nextRoot;
    }
  });
  let closing;
  const app = {
    rootDir, dataDir, events, settings, desktop, host, cdp, session, contextMonitor, quotaMonitor, updater,
    accountManager: null,
    oauthLogin: null,
    status() {
      const currentSettings = settings.get();
      const allTargets = desktop.discoverAllTargets ? desktop.discoverAllTargets(currentSettings) : {};
      const active = session.activeTarget || (desktop.resolveTarget ? desktop.resolveTarget(currentSettings.targetApp, currentSettings) : { id: 'hub', name: 'Antigravity' });
      const bothInstalled = Boolean(allTargets.hub?.exists && allTargets.ide?.exists);
      const accounts = accountManager?.list() || { accounts: [], currentByTarget: { hub: null, ide: null } };
      return {
        ...currentSettings, ...session.snapshot(), ...cdp.status, ...updater.currentState(),
        dictEntries: Object.keys(dictionary).length,
        capabilities: active.capabilities || desktop.capabilities,
        targets: allTargets,
        activeTarget: active.id,
        targetName: active.name,
        bothInstalled,
        accounts,
        accountSwitch: accountManager?.switchStatus || null,
        oauth: oauthLogin?.status() || { ok: true, state: 'idle', active: false }
      };
    },
    async reloadDictionary() {
      dictionary = loadDictionary(rootDir, dataDir);
      await cdp.refresh();
      const count = Object.keys(dictionary).length;
      events.publish({ dictEntries: count });
      return { ok: true, dictEntries: count };
    },
    async configure(input) {
      const previous = settings.get();
      assertLaunchSettingsMutable(input, previous, session.phase);
      const next = settings.update(input);
      const contextChanged = next.enableContextMonitor !== previous.enableContextMonitor;
      const quotaChanged = next.enableQuotaMonitor !== previous.enableQuotaMonitor;
      if (contextChanged) contextMonitor.reset();
      if (quotaChanged) quotaMonitor.reset();
      if (contextChanged || quotaChanged || next.enableI18n !== previous.enableI18n) await cdp.refresh();
      if (next.enableI18n !== previous.enableI18n) events.log('I18N', next.enableI18n ? '汉化已开启' : '汉化已关闭，原文已恢复', 'tag-i18n');
      if (contextChanged) events.log('SYSTEM', next.enableContextMonitor ? '上下文圆环已开启' : '上下文圆环已关闭', 'tag-proxy');
      if (quotaChanged) events.log('SYSTEM', next.enableQuotaMonitor ? '模型用量圆环已开启' : '模型用量圆环已关闭', 'tag-proxy');
      if (input.enableProxy !== undefined && input.enableProxy !== previous.enableProxy) {
        events.log('SYSTEM', next.enableProxy ? `免 TUN 代理已开启（127.0.0.1:${next.port}）` : '免 TUN 代理已关闭（直连模式）', 'tag-proxy');
      }
      if (input.targetApp !== undefined && input.targetApp !== previous.targetApp) {
        const target = desktop.resolveTarget ? desktop.resolveTarget(next.targetApp, next) : { name: next.targetApp };
        events.log('SYSTEM', `已切换启动目标为: ${target.fullName || target.name}`, 'tag-proxy');
        events.publish(app.status());
      }
      if (input.customHubPath !== undefined && input.customHubPath !== previous.customHubPath) {
        events.log('SYSTEM', next.customHubPath ? `已更新桌面版路径: ${next.customHubPath}` : '已恢复桌面版默认检测路径', 'tag-proxy');
        events.publish(app.status());
      }
      if (input.customIdePath !== undefined && input.customIdePath !== previous.customIdePath) {
        events.log('SYSTEM', next.customIdePath ? `已更新 IDE 路径: ${next.customIdePath}` : '已恢复 IDE 默认检测路径', 'tag-proxy');
        events.publish(app.status());
      }
      return next;
    },
    async start() {
      const port = await api.listen(native ? 0 : 19823);
      events.log('SYSTEM', `Antigravity++ 桌面内核就绪，已载入 ${Object.keys(dictionary).length} 条汉化词条`, 'tag-proxy');
      if (process.env.EASYAG_READY_FILE) writeJson(process.env.EASYAG_READY_FILE, { port, pid: process.pid });
      if (!native && !testMode) host.open(`http://127.0.0.1:${port}`);
      void session.attachExisting().catch(error => events.log('SYSTEM', error.message, 'tag-warn'));
      return port;
    },
    close(reason) {
      if (closing) return closing;
      closing = (async () => {
        events.log('SYSTEM', '正在退出: ' + reason, 'tag-warn');
        await oauthLogin?.close();
        const result = await session.close(reason);
        host.dispose();
        api.close();
        onClose(result);
        return result;
      })();
      return closing;
    }
  };
  const api = createApi(app);
  app.api = api;
  accountManager = createAccountManager({
    store: accountStore,
    settings,
    desktop,
    session,
    events,
    configure: input => app.configure(input),
    credentialReader: readCurrentCredentials,
    identityReader: readCurrentIdentity,
    resolveOAuthClient: resolveAccountClient,
    fetchImpl: networkFetch
  });
  app.accountManager = accountManager;
  oauthLogin = createOAuthLogin({
    accountManager,
    host,
    events,
    resolveClient: resolveAccountClient,
    fetchImpl: networkFetch
  });
  app.oauthLogin = oauthLogin;
  return app;
}

module.exports = { createApplication };
