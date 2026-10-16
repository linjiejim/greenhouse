import { Avatar, META, STATES, LABELS, runtime, settings, wake, diagnostics } from './v1/motion.js';
import { V2Avatar } from './v2/avatar.js';
import { PERSONALITIES } from './v2/controller.js';
const $ = (s) => document.querySelector(s),
  gallery = $('#gallery'),
  dialog = $('#detail');
let version = 'compare',
  selected = 0,
  globalState = 'idle',
  localState = 'idle',
  demo = false,
  demoAge = 0,
  sequence = null,
  detailAvatars = [];
const all = [],
  cards = [];
function pair(host, plant, size, { state = 'idle', static: still = false, key = '' } = {}) {
  const avatars = [];
  for (const [name, Class] of [
    ['v1', Avatar],
    ['v2', V2Avatar],
  ]) {
    const wrap = document.createElement('div');
    wrap.className = 'avatar-wrap';
    wrap.dataset.version = name;
    wrap.innerHTML = '<div class="avatar-host"></div><div class="version-label">' + name.toUpperCase() + '</div>';
    host.append(wrap);
    const a = new Class(wrap.firstChild, plant, { size, state, static: still, key });
    a.version = name;
    a.wrap = wrap;
    avatars.push(a);
    all.push(a);
  }
  return avatars;
}
function states(host, handler) {
  STATES.forEach((state, i) => {
    const b = document.createElement('button');
    b.textContent = LABELS[i];
    b.dataset.state = state;
    b.setAttribute('aria-pressed', state === 'idle');
    b.onclick = () => handler(state);
    host.append(b);
  });
}
function press(host, state) {
  host.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.state === state));
}
META.forEach(([plant, name, nick], index) => {
  const card = document.createElement('button');
  card.className = 'card';
  card.dataset.plant = plant;
  card.setAttribute('aria-label', `查看${name}的八种表情`);
  card.innerHTML = '<div class="pair"></div><h3></h3><p></p><p class="state-label"></p>';
  card.querySelector('h3').textContent = name;
  const sub = document.createElement('small');
  sub.textContent = nick;
  card.querySelector('h3').append(sub);
  card.querySelector('p').textContent = PERSONALITIES[plant].name;
  card.querySelector('.state-label').textContent = '待机';
  gallery.append(card);
  const avatars = pair(card.firstChild, plant, 120, { key: 'gallery' });
  cards.push({ card, avatars });
  card.onclick = () => openDetail(index);
});
function visibility() {
  for (const a of all) {
    a.wrap.hidden = version !== 'compare' && a.version !== version;
    a.suspended = a.wrap.hidden || (dialog.open && cards.some((c) => c.avatars.includes(a)));
  }
  wake();
}
function chooseVersion(v) {
  version = v;
  document
    .querySelectorAll('#versions button, #local-versions button')
    .forEach((b) => b.setAttribute('aria-pressed', b.dataset.version === v));
  visibility();
}
function setGlobal(state, fromDemo = false) {
  if (!fromDemo) {
    demo = false;
    $('#demo').textContent = '连续演示';
  }
  sequence = null;
  globalState = state;
  cards.forEach(({ card, avatars }) => {
    avatars.forEach((a) => a.setState(state));
    card.querySelector('.state-label').textContent = LABELS[STATES.indexOf(state)];
  });
  press($('#global-states'), state);
  $('#status').textContent = '当前：' + LABELS[STATES.indexOf(state)];
  if (dialog.open) setLocal(state, fromDemo);
}
function setLocal(state, fromSequence = false) {
  if (!fromSequence) {
    sequence = null;
    demo = false;
    $('#demo').textContent = '连续演示';
  }
  localState = state;
  for (const a of detailAvatars) if (!a.static) a.setState(state);
  press($('#local-states'), state);
  $('#local-status').textContent = '当前：' + LABELS[STATES.indexOf(state)] + ' · 重复点击保持当前动作';
}
function clearDetail() {
  for (const a of detailAvatars) {
    a.dispose();
    all.splice(all.indexOf(a), 1);
  }
  detailAvatars = [];
  for (const id of ['portraits', 'state-sheet', 'samples']) $('#' + id).replaceChildren();
}
function openDetail(index) {
  sequence = null;
  clearDetail();
  selected = (index + 16) % 16;
  const [plant, name, nick] = META[selected];
  $('#detail-title').textContent = name + ' · ' + nick;
  $('#personality').textContent = PERSONALITIES[plant].name + '。视线先回应，动作有停顿。';
  $('#position').textContent = selected + 1 + ' / 16';
  detailAvatars.push(...pair($('#portraits'), plant, 230, { state: globalState, key: 'portrait' }));
  STATES.forEach((state, i) => {
    const b = document.createElement('button');
    b.dataset.state = state;
    b.innerHTML = '<div class="pair"></div><span>' + LABELS[i] + '</span>';
    $('#state-sheet').append(b);
    detailAvatars.push(...pair(b.firstChild, plant, 62, { state, static: true, key: 'sheet' + i }));
    b.onclick = () => setLocal(state);
  });
  for (const size of [16, 20, 32, 44]) {
    const item = document.createElement('div');
    item.innerHTML = '<div class="pair"></div><p>' + size + ' px</p>';
    $('#samples').append(item);
    detailAvatars.push(...pair(item.firstChild, plant, size, { state: 'idle', static: true, key: 'sample' + size }));
  }
  if (!dialog.open) dialog.showModal();
  setLocal(globalState, true);
  visibility();
}
function closeDetail() {
  sequence = null;
  dialog.close();
  clearDetail();
  visibility();
}
states($('#global-states'), setGlobal);
states($('#local-states'), setLocal);
$('#local-versions').onclick = $('#versions').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) chooseVersion(b.dataset.version);
};
$('#theme').onchange = (e) => {
  document.documentElement.dataset.theme = e.target.value;
  settings({ theme: e.target.value });
};
$('#tint').onchange = (e) => settings({ tint: e.target.value });
$('#size').onchange = (e) => {
  const size = +e.target.value;
  gallery.dataset.size = size < 100 ? 'small' : 'standard';
  cards.forEach((c) => c.avatars.forEach((a) => a.resize(size)));
};
$('#local-speed').onchange = $('#speed').onchange = (e) => {
  settings({ speed: +e.target.value });
  $('#speed').value = $('#local-speed').value = e.target.value;
};
$('#local-pause').onclick = $('#pause').onclick = () => {
  settings({ paused: !runtime.paused });
  $('#local-pause').textContent = $('#pause').textContent = runtime.paused ? '继续动画' : '暂停动画';
  $('#pause').setAttribute('aria-pressed', runtime.paused);
};
$('#demo').onclick = () => {
  demo = !demo;
  demoAge = 0;
  $('#demo').textContent = demo ? '停止演示' : '连续演示';
  if (demo) setGlobal('hello', true);
};
$('#close').onclick = closeDetail;
dialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeDetail();
});
$('#previous').onclick = () => openDetail(selected - 1);
$('#next').onclick = () => openDetail(selected + 1);
const sequences = {
  wake: [
    [0, 'sleep'],
    [1.4, 'speaking'],
  ],
  finish: [
    [0, 'thinking'],
    [1.8, 'done'],
  ],
  interrupt: [
    [0, 'hello'],
    [0.16, 'thinking'],
    [0.32, 'speaking'],
    [0.48, 'error'],
    [0.64, 'done'],
    [0.8, 'sleep'],
  ],
};
document.querySelectorAll('[data-scenario]').forEach(
  (b) =>
    (b.onclick = () => {
      demo = false;
      $('#demo').textContent = '连续演示';
      sequence = { age: 0, index: 1, steps: sequences[b.dataset.scenario] };
      setLocal(sequence.steps[0][1], true);
    }),
);
document.addEventListener('motion-frame', (e) => {
  const dt = e.detail.dt;
  if (demo && dt) {
    demoAge += dt;
    if (demoAge > 2.5) {
      demoAge = 0;
      setGlobal(STATES[(STATES.indexOf(globalState) + 1) % 8], true);
    }
  }
  if (sequence && dt) {
    sequence.age += dt;
    while (sequence.index < sequence.steps.length && sequence.age >= sequence.steps[sequence.index][0])
      setLocal(sequence.steps[sequence.index++][1], true);
    if (sequence.index === sequence.steps.length) sequence = null;
  }
});
function preference() {
  $('#preference').textContent = runtime.reduced ? '系统已开启减少动态效果' : '';
}
document.addEventListener('motion-preference', preference);
preference();
visibility();
// Read-only diagnostics plus the same UI actions used by deterministic browser QA.
window.motionReview = {
  get avatars() {
    return [...all];
  },
  get cards() {
    return cards;
  },
  get detail() {
    return detailAvatars;
  },
  get state() {
    return globalState;
  },
  get version() {
    return version;
  },
  setGlobal,
  setLocal,
  openDetail,
  closeDetail,
  chooseVersion,
  diagnostics,
};
