/* global window, document */
window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.source !== window.parent) return;
  if (event.data?.type !== 'greenhouse:init') return;
  const { user, locale, tokens } = event.data;
  document.documentElement.lang = locale;
  for (const [key, value] of Object.entries(tokens ?? {})) {
    if (key.startsWith('--')) document.documentElement.style.setProperty(key, String(value));
  }
  document.getElementById('status').textContent = `Hello, ${user.name}. Your notes stay personal.`;
});
window.parent.postMessage({ type: 'greenhouse:ready' }, window.location.origin);
