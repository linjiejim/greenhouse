/* global window, document, URLSearchParams */
import { connectGreenhouse } from './greenhouse/index.js';
// Desktop is an installed, trusted host, explicitly allowed by the server CSP.
const parentOrigin = new URLSearchParams(window.location.search).get('host_origin');
const bridge = connectGreenhouse({
  hostOrigin: parentOrigin === 'tauri://localhost' ? parentOrigin : window.location.origin,
  onInit({ user }) {
    document.getElementById('status').textContent = `Hello, ${user.name}. Your notes stay personal.`;
    bridge.title('Example notes');
  },
});
document.getElementById('navigate').onclick = () => bridge.navigate('#/ext/example/example-note');
document.getElementById('prompt').onclick = () => bridge.sendPrompt('Help me organize my notes');
document.getElementById('refresh').onclick = async () => {
  try {
    await bridge.refresh();
    document.getElementById('status').textContent = 'Token refreshed';
  } catch (error) {
    document.getElementById('status').textContent = error.message;
  }
};
