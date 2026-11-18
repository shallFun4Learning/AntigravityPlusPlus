const { installI18n } = require('../../features/i18n');
const { installContextWidget } = require('../../features/context-widget');
const { currentConversationId } = require('../../features/conversation-context');

function rendererSource(dictionary, settings, binding, target = 'hub') {
  return `(() => {
    if (window !== window.top) return;
    const generation = (window.__easyagMountGeneration || 0) + 1;
    window.__easyagMountGeneration = generation;
    function mount() {
      if (window.__easyagMountGeneration !== generation) return;
      ${target === 'ide' ? 'window.__easyagI18n?.dispose();' : `(${installI18n.toString()})(window, document, ${JSON.stringify(dictionary)}, ${settings.enableI18n});`}
      (${installContextWidget.toString()})(window, document, ${JSON.stringify({ context: settings.enableContextMonitor === true, quota: settings.enableQuotaMonitor === true })}, event => {
        if (typeof window[${JSON.stringify(binding)}] === 'function') window[${JSON.stringify(binding)}](JSON.stringify(event));
      }, (win, doc) => (${currentConversationId.toString()})(win, doc, ${JSON.stringify(target)}), ${JSON.stringify(binding)});
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
    else mount();
  })();`;
}

const disposeSource = 'window.__easyagMountGeneration = (window.__easyagMountGeneration || 0) + 1; window.__easyagI18n?.dispose(); window.__easyagContext?.dispose();';
module.exports = { rendererSource, disposeSource };
