const {
  tokenNeedsRefresh,
  refreshAccessToken
} = require('./accounts');
const {
  writeCredentials,
  readCurrentCredentials
} = require('../features/antigravity-credentials');

function targetId(value) {
  if (value === 'hub' || value === 'ide') return value;
  return null;
}

function publicResult(account, extra = {}) {
  return { ...extra, account };
}

function sourceLabel(source) {
  const value = typeof source === 'string' ? source : '';
  if (value.startsWith('文件凭据:')) return '本地文件凭据';
  if (value.startsWith('Antigravity 数据库:')) return 'Antigravity 本地数据库';
  if (value === 'macOS 钥匙串') return 'macOS 钥匙串';
  if (value === 'Linux Secret Service') return 'Linux Secret Service';
  return value || '当前登录状态';
}

function createAccountManager({
  store,
  settings,
  desktop,
  session,
  events,
  configure = async input => settings.update(input),
  credentialWriter = writeCredentials,
  credentialReader = readCurrentCredentials,
  identityReader = null,
  resolveOAuthClient,
  fetchImpl = globalThis.fetch
}) {
  function resolveTarget(requested) {
    const explicit = targetId(requested);
    if (explicit) return explicit;
    const current = settings.get();
    const target = desktop.resolveTarget
      ? desktop.resolveTarget(current.targetApp || 'auto', current)
      : { id: current.targetApp === 'ide' ? 'ide' : 'hub' };
    return target.id === 'ide' ? 'ide' : 'hub';
  }

  function targetInfo(target) {
    const current = settings.get();
    if (desktop.resolveTarget) return desktop.resolveTarget(target, current);
    if (desktop.locate) return desktop.locate(target, current);
    return { id: target, name: target, exists: false };
  }

  async function freshAccount(accountId, force = false) {
    const account = store.get(accountId);
    const secrets = store.getSecrets(accountId);
    if (!force && !tokenNeedsRefresh(account, secrets)) return { account, secrets };
    const refreshed = await refreshAccessToken(account, secrets, fetchImpl, resolveOAuthClient);
    const updated = store.updateToken(accountId, refreshed);
    return { account: store.get(updated.id), secrets: store.getSecrets(updated.id) };
  }

  async function restorePrevious(target, previous, previousSecrets, relaunch = false) {
    if (!previous || !previousSecrets) {
      store.clearCurrent(target);
      return;
    }
    try {
      await credentialWriter({
        target,
        targetInfo: targetInfo(target),
        account: previous,
        secrets: previousSecrets
      });
      store.setCurrent(previous.id, target);
      await configure({ targetApp: target });
      if (relaunch && targetInfo(target).exists) {
        const launchResult = await session.launch();
        if (!launchResult.ok) {
          events.log('ACCOUNT', `旧账号已恢复，但重新启动失败: ${launchResult.error}`, 'tag-alert');
        }
      }
    } catch (error) {
      events.log('ACCOUNT', `旧账号恢复失败: ${error.message}`, 'tag-alert');
      store.clearCurrent(target);
    }
  }

  return {
    list() {
      return {
        accounts: store.list(),
        currentByTarget: store.currentIds()
      };
    },

    add(input) {
      const account = store.add(input);
      events.log('ACCOUNT', `已添加账号 ${account.email}`, 'tag-proxy');
      return account;
    },

    async importCurrent(requestedTarget) {
      const target = resolveTarget(requestedTarget);
      const info = targetInfo(target);
      const credential = await credentialReader({
        target,
        targetInfo: info
      });
      if (!credential || typeof credential !== 'object') {
        throw new Error('当前登录状态无法识别');
      }

      let email = typeof credential.email === 'string' ? credential.email.trim() : '';
      if (!email && identityReader) {
        const identity = await identityReader({
          target,
          targetInfo: info,
          credential
        });
        email = typeof identity === 'string'
          ? identity.trim()
          : (typeof identity?.email === 'string' ? identity.email.trim() : '');
      }
      if (!email) {
        throw new Error('已读取到当前登录凭据，但无法确认邮箱。请先启动对应的 Antigravity，再重试。');
      }

      const account = store.add({
        email,
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiryTimestamp: credential.expiryTimestamp,
        idToken: credential.idToken,
        projectId: credential.projectId,
        isGcpTos: credential.isGcpTos
      });
      const source = sourceLabel(credential.source);
      events.log('ACCOUNT', `已从${source}导入账号 ${account.email}`, 'tag-proxy');
      return publicResult(account, {
        ok: true,
        target,
        source
      });
    },

    async refresh(accountId) {
      const { account } = await freshAccount(accountId, true);
      events.log('ACCOUNT', `已刷新账号 ${account.email} 的访问凭据`, 'tag-proxy');
      return account;
    },

    async switch(accountId, requestedTarget) {
      const target = resolveTarget(requestedTarget);
      const selected = store.get(accountId);
      if (selected.disabled) throw new Error(`账号已停用: ${selected.disabledReason || selected.email}`);
      const previous = store.current(target);
      const previousSecrets = previous ? store.getSecrets(previous.id) : null;
      const info = targetInfo(target);
      const sessionWasRunning = session.phase !== 'idle';
      const targetWasRunning = await desktop.running(info);
      const wasRunning = sessionWasRunning || targetWasRunning;

      if (sessionWasRunning) {
        const stopped = await session.stopOnly();
        if (!stopped.ok) throw Object.assign(new Error(stopped.error), { code: stopped.code || 'STOP_FAILED' });
      } else if (targetWasRunning) {
        if (!desktop.stop) {
          throw Object.assign(new Error('当前环境不支持自动退出 Antigravity，无法完成账号切换'), { code: 'STOP_FAILED' });
        }
        const stopped = await desktop.stop(target, { cancelled: () => false });
        if (!stopped?.ok || await desktop.running(info)) {
          throw Object.assign(new Error('Antigravity 未能退出，账号切换已停止，请稍后重试'), { code: 'STOP_FAILED' });
        }
        events.log('SYSTEM', `${info.name || target} 已退出，可以切换账号`, 'tag-proxy');
      }
      if (await desktop.running(info)) {
        throw Object.assign(new Error(`${info.name || target} 仍在运行，请先退出后再切换账号`), { code: 'PROCESS_CONFLICT' });
      }

      let prepared;
      try {
        prepared = await freshAccount(accountId);
        await credentialWriter({
          target,
          targetInfo: info,
          account: prepared.account,
          secrets: prepared.secrets
        });
        store.setCurrent(accountId, target);
        await configure({ targetApp: target });

        let launchResult = { ok: true, launched: false };
        if (info.exists || wasRunning) {
          launchResult = await session.launch();
          if (!launchResult.ok) {
            throw Object.assign(new Error(launchResult.error), { code: launchResult.code || 'LAUNCH_FAILED' });
          }
          launchResult = { ...launchResult, launched: true };
        }
        events.log('ACCOUNT', `已切换到 ${prepared.account.email}（${target === 'ide' ? 'IDE 版' : '桌面版'}）`, 'tag-proxy');
        return publicResult(prepared.account, {
          ok: true,
          target,
          launched: Boolean(launchResult.launched),
          requiresLaunch: !info.exists
        });
      } catch (error) {
        await restorePrevious(target, previous, previousSecrets, wasRunning);
        throw error;
      }
    },

    async remove(accountId) {
      const account = store.get(accountId);
      if (session.phase !== 'idle' && Object.values(store.currentIds()).includes(accountId)) {
        throw new Error('当前账号正在使用，请先退出 Antigravity 后再删除');
      }
      store.remove(accountId);
      events.log('ACCOUNT', `已删除账号 ${account.email}`, 'tag-proxy');
      return { ok: true };
    },

    current(target) {
      const resolved = resolveTarget(target);
      return { target: resolved, account: store.current(resolved) };
    }
  };
}

module.exports = { createAccountManager };
