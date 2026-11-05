/* global window, document, URLSearchParams, fetch */
import { connectGreenhouse } from './greenhouse/index.js';

// The page's words in both host languages; the host names the language at init.
const WORDS = {
  en: {
    title: 'Example notes',
    hello: (name) => `Hello, ${name}. Your notes stay personal.`,
    people: (n) => `${n} people on this station.`,
    open: 'Open notes',
    ask: 'Ask the assistant',
    prompt: 'Help me organize my notes',
    refresh: 'Refresh token',
    refreshed: 'Token refreshed',
    pictureTitle: 'A note with a picture',
    choose: 'Choose a picture',
    uploading: 'Uploading…',
    attached: 'Attached to a new note.',
    describe: 'Describe it',
    looking: 'Looking…',
    clear: 'Delete note',
    clearTitle: 'Delete this picture note?',
    clearBody: 'The note and its picture are deleted for good.',
    uploadFailed: 'The picture didn’t upload. Check the file and retry.',
    failed: 'That didn’t work. Retry in a moment.',
    retry: 'Retry',
  },
  zh: {
    title: '示例笔记',
    hello: (name) => `你好，${name}。笔记只有你自己能看到。`,
    people: (n) => `这个工作站有 ${n} 位成员。`,
    open: '打开笔记',
    ask: '问助手',
    prompt: '帮我整理一下笔记',
    refresh: '刷新令牌',
    refreshed: '令牌已刷新',
    pictureTitle: '带图片的笔记',
    choose: '选择图片',
    uploading: '上传中…',
    attached: '已附加到一条新笔记。',
    describe: '描述图片',
    looking: '正在看…',
    clear: '删除笔记',
    clearTitle: '删除这条带图片的笔记？',
    clearBody: '笔记和图片都会被永久删除。',
    uploadFailed: '图片没有上传成功，请检查文件后重试。',
    failed: '没有成功，请稍后重试。',
    retry: '重试',
  },
};
let words = WORDS.en;
const $ = (id) => document.getElementById(id);

// Desktop is an installed, trusted host, explicitly allowed by the server CSP.
const parentOrigin = new URLSearchParams(window.location.search).get('host_origin');
const bridge = connectGreenhouse({
  hostOrigin: parentOrigin === 'tauri://localhost' ? parentOrigin : window.location.origin,
  onInit({ user, locale }) {
    words = WORDS[locale] ?? WORDS.en;
    for (const node of document.querySelectorAll('[data-text]')) node.textContent = words[node.dataset.text];
    // The host bar carries the title: the page draws no second one.
    $('status').textContent = words.hello(user.name);
    bridge.title(words.title);
    // An embed token also reaches the member directory (owner pickers) and its plugin's drive scopes.
    fetch('/api/people', { headers: { Authorization: `Bearer ${bridge.token}` } })
      .then((response) => (response.ok ? response.json() : { people: [] }))
      .then(({ people }) => {
        $('colleagues').textContent = words.people(people.length);
      })
      .catch(() => {});
  },
});
$('navigate').onclick = () => bridge.navigate('/p/example/example-note');
$('prompt').onclick = () => bridge.sendPrompt(words.prompt);
$('refresh').onclick = async () => {
  try {
    await bridge.refresh();
    // The result is not on screen: the host says it once.
    bridge.notify({ kind: 'success', text: words.refreshed });
  } catch {
    bridge.notify({ kind: 'error', text: words.failed });
  }
};

// A note with a picture: the plugin API hands out an upload target from its own object store
// (a presigned bucket URL, or an /api/ext-objects ticket on local disk). The PUT carries no
// Bearer — the URL is the capability — and the API checks the stored size before attaching it.
const api = async (path, body, method = 'POST') => {
  const response = await fetch(`/api/ext/example${path}`, {
    method,
    headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error || words.failed);
  return json;
};
let pictureNote = null;
const upload = async (file) => {
  const status = $('picture-status');
  try {
    status.textContent = words.uploading;
    const { note } = await api('/notes', { body: `Picture: ${file.name}`.slice(0, 500) });
    const { upload } = await api(`/notes/${note.id}/picture`, { content_type: file.type, size: file.size });
    const put = await fetch(upload.url, { method: upload.method, headers: upload.headers, body: file });
    if (!put.ok) throw new Error(words.uploadFailed);
    const done = await api(`/notes/${note.id}/picture/complete`, { content_type: file.type });
    pictureNote = note.id;
    const preview = $('picture-preview');
    preview.src = done.picture_url;
    preview.alt = file.name;
    preview.hidden = false;
    $('picture-describe').hidden = false;
    $('picture-clear').hidden = false;
    status.textContent = words.attached;
  } catch {
    // The failure stays where it happened, with a way to try again.
    status.textContent = '';
    const answer = await bridge.notify({ kind: 'error', text: words.uploadFailed, actionLabel: words.retry });
    if (answer === 'action') void upload(file);
  }
};
$('picture-file').onchange = (event) => {
  const file = event.target.files?.[0];
  if (file) void upload(file);
  event.target.value = '';
};
$('picture-describe').onclick = async () => {
  const out = $('picture-description');
  try {
    out.textContent = words.looking;
    out.textContent = (await api(`/notes/${pictureNote}/picture/describe`, {})).description;
  } catch {
    out.textContent = '';
    bridge.notify({ kind: 'error', text: words.failed });
  }
};
// Deleting cannot be undone, so it asks first; the host draws the question over the whole app.
$('picture-clear').onclick = async () => {
  const ok = await bridge.confirm({
    title: words.clearTitle,
    body: words.clearBody,
    confirmLabel: words.clear,
    tone: 'danger',
  });
  if (!ok) return;
  try {
    await api(`/notes/${pictureNote}`, undefined, 'DELETE');
  } catch {
    bridge.notify({ kind: 'error', text: words.failed });
    return;
  }
  // The result is on screen (the picture is gone): nothing more to say.
  pictureNote = null;
  const preview = $('picture-preview');
  preview.hidden = true;
  preview.removeAttribute('src');
  $('picture-describe').hidden = true;
  $('picture-clear').hidden = true;
  $('picture-description').textContent = '';
  $('picture-status').textContent = '';
};
