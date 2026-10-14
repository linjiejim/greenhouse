/**
 * The page the computer screen's WebView runs: noVNC (./novnc.generated.ts,
 * built from the web's own @novnc/novnc) and a small viewer around it. Pure —
 * no React — so the root vitest can read the page and the message shapes.
 *
 * Who does what:
 * - The app (./use-computer-screen.ts) owns the connection: it mints each
 *   one-time ticket (`view` or `control`) with the member's bearer token and
 *   hands the page only the `wss://…?ticket=` URL; it backs off and pauses in
 *   the background.
 * - The page owns the pixels and the fingers. noVNC's own touch handling is
 *   kept away from the canvas (it calls preventDefault on every touch, and a
 *   pinch would zoom the remote browser): the viewer captures touches on the
 *   stage and decides —
 *     · two fingers: zoom (pinch) and pan the picture here; at fit size, a
 *       two-finger swipe scrolls the remote page instead;
 *     · one finger while watching: pan;
 *     · one finger in control: tap = click, hold = right click, drag = drag —
 *       sent as ordinary mouse events on the canvas, which noVNC forwards.
 *   Zoom resizes the picture's box (noVNC rescales to it); position is a
 *   translate — never a CSS scale, which would break noVNC's pointer mapping.
 *
 * Bridge: app → page `window.gh.<command>(…)` via injectJavaScript; page → app
 * `ReactNativeWebView.postMessage(JSON)` read by `readViewerMessage`. The page
 * loads nothing from the network but the screen's WebSocket.
 */

import { NOVNC_SOURCE } from './novnc.generated';

/** The helper keys the control bar offers, as X11 keysyms + DOM codes (web: lib/novnc/types.ts, plus paging). */
export const HELPER_KEYS = {
  escape: [0xff1b, 'Escape'],
  tab: [0xff09, 'Tab'],
  backspace: [0xff08, 'Backspace'],
  enter: [0xff0d, 'Enter'],
  pageUp: [0xff55, 'PageUp'],
  pageDown: [0xff56, 'PageDown'],
} as const;

export type HelperKey = keyof typeof HELPER_KEYS;

export type ViewerMessage =
  /** noVNC has loaded: the page takes `connect` now. */
  | { t: 'ready' }
  | { t: 'connected' }
  /** The socket closed (`clean`: closed on purpose or by the server, not a network failure). */
  | { t: 'disconnected'; clean: boolean }
  /** A tap while watching — the app explains why nothing happened. */
  | { t: 'tap-view-only' }
  /** Zoom factor over "fit" (1 = the whole desktop). */
  | { t: 'zoom'; z: number };

export function readViewerMessage(data: string): ViewerMessage | null {
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const msg = m as Record<string, unknown>;
  switch (msg.t) {
    case 'ready':
    case 'connected':
    case 'tap-view-only':
      return { t: msg.t };
    case 'disconnected':
      return { t: 'disconnected', clean: msg.clean === true };
    case 'zoom':
      return typeof msg.z === 'number' && Number.isFinite(msg.z) ? { t: 'zoom', z: msg.z } : null;
    default:
      return null;
  }
}

/** A command for `injectJavaScript` (always ends in `true;`, as react-native-webview asks). */
export function viewerCommand(name: 'connect', url: string): string;
export function viewerCommand(name: 'viewOnly', on: boolean): string;
export function viewerCommand(name: 'key', key: HelperKey): string;
export function viewerCommand(name: 'type', text: string): string;
export function viewerCommand(name: 'zoom', to: 'fit' | 'in' | 'out'): string;
export function viewerCommand(name: 'disconnect'): string;
export function viewerCommand(name: string, arg?: unknown): string {
  return `window.gh&&window.gh.${name}(${arg === undefined ? '' : JSON.stringify(arg)});true;`;
}

// The viewer itself — plain ES2017 for WKWebView, no build step. Kept in one
// template so the whole page reads top to bottom.
const VIEWER_JS = String.raw`
(function () {
  var KEYS = __KEYS__;
  var stage = document.getElementById('stage');
  var box = document.getElementById('screen');
  var RFB = null, rfb = null, pending = null, viewOnly = true;
  var fbW = 1280, fbH = 800, zoom = 1, x = 0, y = 0;
  var MAX_ZOOM = 4, TAP_SLOP = 8, HOLD_MS = 550, WHEEL_PX = 40;

  function post(m) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(m)); }

  // ── layout: "fit" = the whole desktop in the stage; zoom multiplies it ──
  function fit() {
    var s = Math.min(stage.clientWidth / fbW, stage.clientHeight / fbH);
    return { w: fbW * s, h: fbH * s };
  }
  function layout() {
    var W = stage.clientWidth, H = stage.clientHeight, b = fit();
    var w = b.w * zoom, h = b.h * zoom;
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    x = w <= W ? (W - w) / 2 : Math.min(0, Math.max(W - w, x));
    y = h <= H ? (H - h) / 2 : Math.min(0, Math.max(H - h, y));
    box.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }
  // Zoom to z keeping the stage point (cx, cy) over the same desktop point.
  function zoomTo(z, cx, cy) {
    z = Math.max(1, Math.min(MAX_ZOOM, z));
    var k = z / zoom;
    x = cx - (cx - x) * k;
    y = cy - (cy - y) * k;
    zoom = z;
    layout();
  }
  function reportZoom() { post({ t: 'zoom', z: Math.round(zoom * 100) / 100 }); }
  window.addEventListener('resize', layout);
  // The framebuffer size arrives with the connection (and may change): follow the canvas.
  function watchCanvas() {
    var canvas = box.querySelector('canvas');
    if (!canvas) return;
    var sync = function () {
      if (canvas.width > 0 && canvas.height > 0 && (canvas.width !== fbW || canvas.height !== fbH)) {
        fbW = canvas.width; fbH = canvas.height; layout();
      }
    };
    new MutationObserver(sync).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    sync();
  }

  // ── mouse events noVNC reads off the canvas ──
  function canvas() { return box.querySelector('canvas'); }
  function mouse(type, t, buttons) {
    var c = canvas();
    if (!c) return;
    // After a press noVNC "captures" the mouse with a full-page proxy element
    // (no Element.setCapture here): moves and the release must go through it,
    // as a real pointer's would, or the capture is never released.
    var proxy = document.getElementById('noVNC_mouse_capture_elem');
    var target = type !== 'mousedown' && proxy && proxy.style.display !== 'none' ? proxy : c;
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: t.x, clientY: t.y, button: buttons === 2 ? 2 : 0, buttons: buttons }));
  }
  function wheel(t, dy) {
    var c = canvas();
    if (!c) return;
    c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: t.x, clientY: t.y, deltaY: dy, deltaMode: 0 }));
  }

  // ── fingers ──
  var g = null; // the gesture in progress
  function pt(touch) { return { x: touch.clientX, y: touch.clientY }; }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function endPointer() {
    if (!g || g.kind !== 'pointer') return;
    clearTimeout(g.hold);
    if (g.down) mouse('mouseup', g.last, 0);
  }
  function onTouch(e) {
    e.stopPropagation();
    e.preventDefault();
    var touches = e.touches;
    if (e.type === 'touchstart' || (e.type !== 'touchmove' && touches.length > 0)) {
      // A finger joined or left: restart from the fingers still down.
      var was = g;
      endPointer();
      if (touches.length >= 2) {
        var a = pt(touches[0]), b = pt(touches[1]);
        g = { kind: 'two', d: dist(a, b), z: zoom, m: mid(a, b), pinch: false, wheel: 0 };
      } else if (was && was.kind === 'two') {
        // The rest of a pinch: nothing until every finger is up (never a stray click).
        g = { kind: 'idle' };
      } else if (touches.length === 1) {
        var p = pt(touches[0]);
        if (viewOnly) g = { kind: 'pan', start: p, last: p };
        else {
          var mine = { kind: 'pointer', start: p, last: p, moved: false, down: false, right: false };
          mine.hold = setTimeout(function () {
            if (g !== mine || mine.moved) return;
            // Hold = right click.
            mine.right = true;
            mouse('mousemove', mine.start, 0);
            mouse('mousedown', mine.start, 2);
            mouse('mouseup', mine.start, 0);
          }, HOLD_MS);
          g = mine;
        }
      } else g = null;
      return;
    }
    if (e.type === 'touchmove' && g) {
      if (g.kind === 'two' && touches.length >= 2) {
        var a2 = pt(touches[0]), b2 = pt(touches[1]), m2 = mid(a2, b2);
        var scale = g.d > 0 ? dist(a2, b2) / g.d : 1;
        if (!g.pinch && Math.abs(scale - 1) > 0.06) g.pinch = true;
        if (g.pinch || g.z > 1.001) {
          // Zoomed (or zooming): the fingers move and scale the picture here.
          x += m2.x - g.m.x;
          y += m2.y - g.m.y;
          zoomTo(g.pinch ? g.z * scale : zoom, m2.x, m2.y);
        } else if (!viewOnly) {
          // At fit size a two-finger swipe scrolls the remote page (content follows the fingers).
          g.wheel += m2.y - g.m.y;
          while (Math.abs(g.wheel) >= WHEEL_PX) {
            wheel(m2, g.wheel > 0 ? -50 : 50);
            g.wheel += g.wheel > 0 ? -WHEEL_PX : WHEEL_PX;
          }
        }
        g.m = m2;
      } else if (g.kind === 'pan' && touches.length === 1) {
        var p2 = pt(touches[0]);
        x += p2.x - g.last.x;
        y += p2.y - g.last.y;
        g.last = p2;
        layout();
      } else if (g.kind === 'pointer' && touches.length === 1) {
        var p3 = pt(touches[0]);
        if (!g.moved && !g.right && dist(p3, g.start) > TAP_SLOP) {
          g.moved = true;
          clearTimeout(g.hold);
          mouse('mousemove', g.start, 0);
          mouse('mousedown', g.start, 1);
          g.down = true;
        }
        if (g.down) mouse('mousemove', p3, 1);
        g.last = p3;
      }
      return;
    }
    // The last finger left.
    if (g && g.kind === 'pointer') {
      clearTimeout(g.hold);
      if (g.down) mouse('mouseup', g.last, 0);
      else if (!g.right) {
        mouse('mousemove', g.start, 0);
        mouse('mousedown', g.start, 1);
        mouse('mouseup', g.start, 0);
      }
    } else if (g && g.kind === 'two') reportZoom();
    else if (g && g.kind === 'pan' && dist(g.last, g.start) < TAP_SLOP) post({ t: 'tap-view-only' });
    g = null;
  }
  // On the document, in the capture phase: before noVNC's own touch handler on
  // the canvas, and above its mouse-capture proxy.
  ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(function (type) {
    document.addEventListener(type, onTouch, { capture: true, passive: false });
  });

  // ── the bridge ──
  function connect(url) {
    if (!RFB) { pending = url; return; }
    disconnect();
    var client = new RFB(box, url, { shared: true });
    client.scaleViewport = true;
    client.resizeSession = false;
    client.clipViewport = false;
    client.focusOnClick = false;
    client.background = 'transparent';
    client.viewOnly = viewOnly;
    client.addEventListener('connect', function () {
      if (rfb !== client) return;
      watchCanvas();
      post({ t: 'connected' });
    });
    client.addEventListener('disconnect', function (ev) {
      if (rfb !== client) return;
      rfb = null;
      post({ t: 'disconnected', clean: !!(ev && ev.detail && ev.detail.clean) });
    });
    rfb = client;
  }
  function disconnect() {
    var client = rfb;
    rfb = null;
    if (client) { try { client.disconnect(); } catch (err) { /* already closed */ } }
  }
  window.gh = {
    connect: connect,
    disconnect: disconnect,
    viewOnly: function (on) {
      viewOnly = !!on;
      endPointer();
      g = null;
      if (rfb) rfb.viewOnly = viewOnly;
    },
    key: function (name) {
      var k = KEYS[name];
      if (rfb && k) rfb.sendKey(k[0], k[1]);
    },
    // Text into whatever has the focus, key by key: Latin-1 as itself, the rest as Unicode
    // keysyms (0x1000000 + code point), a line break as Enter.
    type: function (text) {
      if (!rfb || viewOnly) return;
      Array.from(String(text)).forEach(function (ch) {
        if (ch === '\n') { rfb.sendKey(0xff0d, 'Enter'); return; }
        var cp = ch.codePointAt(0);
        rfb.sendKey(cp < 0x100 ? cp : 0x1000000 + cp, null);
      });
    },
    zoom: function (to) {
      var cx = stage.clientWidth / 2, cy = stage.clientHeight / 2;
      if (to === 'fit') zoomTo(1, cx, cy);
      else zoomTo(zoom * (to === 'in' ? 1.6 : 1 / 1.6), cx, cy);
      reportZoom();
    }
  };
  function ready() {
    if (RFB || !window.RFB) return;
    RFB = window.RFB;
    layout();
    post({ t: 'ready' });
    if (pending) { var url = pending; pending = null; connect(url); }
  }
  window.addEventListener('rfb-ready', ready);
  layout();
  ready();
})();
`;

/** The whole page. `background` shows around the picture (the app's grouped background). */
export function viewerHtml(background: string): string {
  const keys = JSON.stringify(Object.fromEntries(Object.entries(HELPER_KEYS)));
  // An inline script ends at the first "</script" whatever surrounds it.
  const novnc = NOVNC_SOURCE.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
html,body{margin:0;height:100%;overflow:hidden;touch-action:none;background:${background};-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
#stage{position:fixed;inset:0;overflow:hidden;touch-action:none}
#screen{position:absolute;left:0;top:0;transform-origin:0 0}
</style></head><body><div id="stage"><div id="screen"></div></div>
<script>${VIEWER_JS.replace('__KEYS__', keys)}</script>
<script type="module">${novnc}</script>
</body></html>`;
}
