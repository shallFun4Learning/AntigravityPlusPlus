const element = id => document.getElementById(id);
const pageTitles = { home: '工作台', accounts: '账号管理', network: '网络设置', enhance: '界面增强', logs: '运行日志' };

export function openView(view) {
  if (!Object.keys(pageTitles).includes(view)) return;
  for (const page of document.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== view;
  for (const button of document.querySelectorAll('nav [data-view]')) {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  const home = element('homeSettings');
  if (view === 'home') home.append(element('networkCard'), element('enhanceCard'));
  if (view === 'network') element('networkSlot').append(element('networkCard'));
  if (view === 'enhance') element('enhanceSlot').append(element('enhanceCard'));
  element('pageTitle').textContent = pageTitles[view];
  element('workspace').scrollTop = 0;
  element('pageTitle').focus({ preventScroll: true });
  if (view === 'logs') element('consoleBox').scrollTop = element('consoleBox').scrollHeight;
}

export function showNotice(message, kind = 'info') {
  const notice = element('actionNotice');
  notice.hidden = false;
  notice.dataset.kind = kind;
  element('noticeText').textContent = message;
}

function textNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const categoryLabels = { SYSTEM: '系统', ACCOUNT: '账号', I18N: '汉化', PROXY: '代理', CDP: '客户端', UPDATE: '更新' };

export function recordActivity(time, category, message) {
  const recent = element('recentActivity');
  recent.querySelector('.empty')?.remove();
  const row = document.createElement('div');
  row.className = 'recent-row';
  row.append(textNode('time', '', time), textNode('span', 'category', categoryLabels[category] || category), textNode('span', 'message', message));
  row.title = message;
  recent.prepend(row);
  if (recent.children.length > 3) recent.lastElementChild.remove();
}

export function clearActivity() {
  element('recentActivity').replaceChildren(textNode('p', 'empty', '暂无运行记录'));
}

export function accountDisplayName(account) { return account.label || account.email || '未命名账号'; }

function avatarText(account) {
  const first = Array.from(accountDisplayName(account).trim())[0];
  return first ? first.toLocaleUpperCase() : '·';
}

const stageLabels = {
  checking: '检查客户端状态', stopping: '退出客户端', writing: '更新登录状态',
  launching: '启动客户端', restoring: '恢复切换前的状态'
};

export function createAccountPanel({ onSwitch, onRefresh, onDelete }) {
  const list = element('accountList');
  const search = element('accountSearch');
  let selectedId = null;
  let lastTarget;
  let model;
  let previousRows;
  let detailId = null;

  function render(state = model) {
    if (!state) return;
    model = state;
    const { accounts, currentByTarget, target, progress, locked, switchBlockedReason } = state;
    const currentId = currentByTarget[target];
    const current = accounts.find(account => account.id === currentId);
    const targetName = target === 'ide' ? 'IDE 版' : '桌面版';
    element('sessionAccount').textContent = current ? accountDisplayName(current) : '尚未指定账号';
    element('accountCurrentSummary').textContent = current ? `${targetName} · ${current.email}` : `${targetName} · 可在账号管理中选择登录身份`;
    element('accountCount').textContent = accounts.length;
    if (lastTarget !== target) {
      selectedId = currentId;
      search.value = '';
      lastTarget = target;
    }
    const query = search.value.trim().toLocaleLowerCase();
    const visible = accounts.filter(account => `${account.label || ''} ${account.email || ''}`.toLocaleLowerCase().includes(query));
    const selected = visible.find(account => account.id === selectedId) || visible.find(account => account.id === currentId) || visible[0];
    selectedId = selected?.id || null;
    if (detailId !== selectedId) {
      element('accountOptions').open = false;
      detailId = selectedId;
    }
    const rowsKey = JSON.stringify([visible.map(({ id, email, label }) => [id, email, label]), currentId, Boolean(query)]);
    if (rowsKey !== previousRows) {
      previousRows = rowsKey;
      const focusedId = document.activeElement?.dataset.account;
      const rows = visible.map(account => {
        const button = document.createElement('button');
        button.className = 'account-item';
        button.dataset.account = account.id;
        button.title = account.email;
        const copy = document.createElement('span');
        copy.className = 'account-copy';
        copy.append(textNode('strong', '', accountDisplayName(account)));
        if (account.label && account.label !== account.email) copy.append(textNode('small', '', account.email));
        button.append(textNode('span', 'avatar', avatarText(account)), copy);
        if (account.id === currentId) button.append(textNode('span', 'current-label', '当前使用'));
        return button;
      });
      list.replaceChildren(...(rows.length ? rows : [textNode('p', 'empty', query ? '没有匹配的账号' : '账号库为空')]));
      if (focusedId) rows.find(row => row.dataset.account === focusedId)?.focus({ preventScroll: true });
    }
    for (const button of list.querySelectorAll('[data-account]')) {
      button.setAttribute('aria-pressed', String(button.dataset.account === selectedId));
    }
    element('detailEmpty').hidden = Boolean(selected);
    element('accountDetail').hidden = !selected;
    element('detailEmpty').querySelector('p').textContent = query ? '试试其他名称或邮箱。' : '导入当前登录或添加账号后，可在这里查看和切换。';
    if (selected) {
      element('detailAvatar').textContent = avatarText(selected);
      element('detailName').textContent = accountDisplayName(selected);
      element('detailEmail').textContent = selected.label && selected.label !== selected.email ? selected.email : '';
      element('detailTarget').textContent = targetName;
      element('detailCurrent').textContent = current ? accountDisplayName(current) : '尚未指定';
      const credentialText = selected.hasRefreshToken ? '可刷新' : selected.hasAccessToken ? '仅访问凭据' : '缺少凭据';
      const expiry = selected.tokenExpiresAt ? ` · ${new Date(selected.tokenExpiresAt).toLocaleDateString()} 到期` : '';
      element('detailCredential').textContent = credentialText + expiry;
      const isCurrent = selectedId === currentId;
      const switchButton = element('switchAccountBtn');
      switchButton.disabled = locked || isCurrent || Boolean(selected.disabled) || Boolean(switchBlockedReason);
      switchButton.textContent = isCurrent ? '当前使用中' : '切换并重启';
      element('switchHint').textContent = switchBlockedReason || (isCurrent ? `此账号已用于${targetName}。` : `确认后将重新启动${targetName}，请先保存工作。`);
      element('switchSteps').hidden = isCurrent || Boolean(switchBlockedReason);
      const activeStage = progress?.target === target && progress.accountId === selectedId && progress.state === 'working' ? progress.stage : null;
      for (const step of element('switchSteps').children) {
        if (step.dataset.stage === activeStage) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      }
      element('refreshAccountBtn').disabled = locked || !selected.hasRefreshToken;
      element('deleteAccountBtn').disabled = locked;
    }
    const feedback = element('switchProgress');
    feedback.hidden = !progress || progress.target !== target;
    if (!feedback.hidden) {
      const name = accounts.find(account => account.id === progress.accountId);
      const prefix = name ? `${accountDisplayName(name)} · ` : '';
      const stage = stageLabels[progress.stage] || '切换账号';
      let text = `正在${stage}…`;
      if (progress.state === 'failed') text = `${stage}失败。${progress.error}`;
      if (progress.state === 'done') text = progress.launched ? `${targetName}已启动` : '已切换，请配置客户端路径后启动';
      feedback.dataset.state = progress.state;
      if (feedback.textContent !== prefix + text) feedback.textContent = prefix + text;
    }
  }

  search.addEventListener('input', () => render());
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-account]');
    if (!button) return;
    selectedId = button.dataset.account;
    render();
  });
  element('switchAccountBtn').addEventListener('click', () => onSwitch(selectedId));
  element('refreshAccountBtn').addEventListener('click', () => onRefresh(selectedId));
  element('deleteAccountBtn').addEventListener('click', () => onDelete(selectedId));
  return {
    render,
    select(accountId) {
      search.value = '';
      selectedId = accountId;
    }
  };
}
