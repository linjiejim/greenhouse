/* global window, document, URLSearchParams, fetch */
import { connectGreenhouse } from './greenhouse/index.js';
// Desktop is an installed, trusted host, explicitly allowed by the server CSP.
const parentOrigin = new URLSearchParams(window.location.search).get('host_origin');
const bridge = connectGreenhouse({
  hostOrigin: parentOrigin === 'tauri://localhost' ? parentOrigin : window.location.origin,
  onInit({ user }) {
    document.getElementById('status').textContent = `Hello, ${user.name}. Your notes stay personal.`;
    bridge.title('Example notes');
    // An embed token also reaches the member directory (owner pickers) and its plugin's drive scopes.
    fetch('/api/people', { headers: { Authorization: `Bearer ${bridge.token}` } })
      .then((response) => (response.ok ? response.json() : { people: [] }))
      .then(({ people }) => {
        document.getElementById('colleagues').textContent = `${people.length} people on this station.`;
      })
      .catch(() => {});
  },
});
document.getElementById('navigate').onclick = () => bridge.navigate('/p/example/example-note');
document.getElementById('prompt').onclick = () => bridge.sendPrompt('Help me organize my notes');
document.getElementById('refresh').onclick = async () => {
  try {
    await bridge.refresh();
    document.getElementById('status').textContent = 'Token refreshed';
  } catch (error) {
    document.getElementById('status').textContent = error.message;
  }
};

// A note with a picture: the plugin API hands out an upload target from its own object store
// (a presigned bucket URL, or an /api/ext-objects ticket on local disk). The PUT carries no
// Bearer — the URL is the capability — and the API checks the stored size before attaching it.
const api = async (path, body) => {
  const response = await fetch(`/api/ext/example${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
};
let pictureNote = null;
document.getElementById('picture-file').onchange = async (event) => {
  const file = event.target.files?.[0];
  const status = document.getElementById('picture-status');
  if (!file) return;
  try {
    status.textContent = 'Uploading…';
    const { note } = await api('/notes', { body: `Picture: ${file.name}`.slice(0, 500) });
    const { upload } = await api(`/notes/${note.id}/picture`, { content_type: file.type, size: file.size });
    const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file });
    if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
    const done = await api(`/notes/${note.id}/picture/complete`, { content_type: file.type });
    pictureNote = note.id;
    const preview = document.getElementById('picture-preview');
    preview.src = done.picture_url;
    preview.alt = file.name;
    preview.hidden = false;
    document.getElementById('picture-describe').hidden = false;
    status.textContent = 'Attached to a new note.';
  } catch (error) {
    status.textContent = error.message;
  }
};
document.getElementById('picture-describe').onclick = async () => {
  const out = document.getElementById('picture-description');
  try {
    out.textContent = 'Looking…';
    out.textContent = (await api(`/notes/${pictureNote}/picture/describe`, {})).description;
  } catch (error) {
    out.textContent = error.message;
  }
};
