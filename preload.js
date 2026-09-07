const { ipcRenderer } = require('electron');

function flashPluginDescriptions() {
  return Array.from(navigator.plugins || [])
    .filter((plugin) => /flash/i.test(plugin.name) || /flash/i.test(plugin.description))
    .map((plugin) => `${plugin.name}: ${plugin.description}`)
    .slice(0, 5);
}

function reportFlashState(stage) {
  const container = document.getElementById('flashContent');
  const flash = document.getElementById('flashapp')
    || (container && container.querySelector('embed, object'));
  const bounds = container && container.getBoundingClientRect();
  ipcRenderer.send('launcher-debug', {
    stage,
    url: `${location.origin}${location.pathname}`,
    plugins: flashPluginDescriptions(),
    container: container ? {
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
      children: container.children.length,
    } : null,
    flash: flash ? {
      tagName: flash.tagName,
      type: flash.getAttribute('type'),
      width: flash.getAttribute('width'),
      height: flash.getAttribute('height'),
    } : null,
  });
}

reportFlashState('preload-loaded');

window.addEventListener('DOMContentLoaded', () => {
  reportFlashState('dom-ready');
  setTimeout(() => reportFlashState('2-seconds'), 2000);
  setTimeout(() => reportFlashState('10-seconds'), 10000);
});
