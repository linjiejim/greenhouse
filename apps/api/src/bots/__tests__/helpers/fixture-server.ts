/**
 * A tiny local website for browser/vault tests: a sign-in form, two-step
 * sign-ins (user name first — as separate pages, as a single-page app, and
 * one whose second step never comes), an OTP step (single field and split
 * boxes), a CAPTCHA page, a "Just a moment" page, a page with pre-filled
 * secrets, popups and a long page. Form posts are recorded so tests can
 * assert what the site actually received.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureSite {
  origin: string;
  /** Bodies of form posts, in order (`path` + parsed fields). */
  submissions: Array<{ path: string; fields: Record<string, string> }>;
  close(): Promise<void>;
  /** Pages registered at runtime (path → html). */
  pages: Map<string, string>;
}

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function defaultPages(otherOrigin: () => string): Map<string, string> {
  return new Map<string, string>([
    [
      '/login',
      page(
        'Sign in',
        `<h1>Sign in</h1>
        <form method="post" action="/session">
          <label>Email <input name="login" autocomplete="username" type="text"></label>
          <label>Password <input name="password" type="password" autocomplete="current-password"></label>
          <button type="submit">Sign in</button>
        </form>`,
      ),
    ],
    [
      '/login-step1',
      page(
        'Sign in',
        `<form method="post" action="/step1"><label>Email address <input type="email" name="identifier"></label><button>Next</button></form>`,
      ),
    ],
    [
      '/login-step2',
      page(
        'Enter your password',
        `<p>me@example.com</p><form method="post" action="/session"><label>Password <input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>`,
      ),
    ],
    [
      // User name first, then the password on the same document after a moment (Google-style).
      '/login-spa',
      page(
        'Sign in',
        `<form id="f" method="post" action="/session-spa">
          <div id="s1"><label>Email address <input type="email" name="identifier"></label></div>
          <div id="s2" hidden><label>Password <input type="password" name="password"></label></div>
          <button>Next</button>
        </form>
        <script>
          let step = 1;
          document.getElementById('f').addEventListener('submit', (event) => {
            if (step !== 1) return;
            event.preventDefault();
            step = 2;
            setTimeout(() => {
              document.getElementById('s1').hidden = true;
              document.getElementById('s2').hidden = false;
            }, 400);
          });
        </script>`,
      ),
    ],
    [
      // A first step whose password screen never comes (an error page, an account chooser…).
      '/login-dead-end',
      page(
        'Sign in',
        `<form method="post" action="/step1-dead"><label>Email address <input type="email" name="identifier"></label><button>Next</button></form>`,
      ),
    ],
    [
      '/otp',
      page(
        'Two-factor',
        `<h1>Enter the code from your app</h1>
        <form method="post" action="/verify">
          <label>Authentication code <input name="app_otp" autocomplete="one-time-code" inputmode="numeric"></label>
          <button type="submit">Verify</button>
        </form>`,
      ),
    ],
    [
      '/split-otp',
      page(
        'Verify',
        `<form method="post" action="/verify-split">${[0, 1, 2, 3, 4, 5]
          .map((i) => `<input name="d${i}" maxlength="1" inputmode="numeric" aria-label="Digit ${i + 1}">`)
          .join('')}<button>Verify</button></form>`,
      ),
    ],
    [
      '/home',
      page(
        'Dashboard',
        `<h1>Welcome back</h1>
        <a href="/page2">Next page</a>
        <a href="/popup" target="_blank">Open report</a>
        <label>Plan <select name="plan"><option value="free">Free</option><option value="pro">Pro plan</option></select></label>
        <label>Search <input name="q" type="search"></label>
        <div style="height:3000px">tall</div><p id="bottom">Bottom of the page</p>`,
      ),
    ],
    ['/page2', page('Second page', '<h1>Second page</h1><p>Some content</p>')],
    ['/popup', page('Report', '<h1>Quarterly report</h1>')],
    [
      '/captcha',
      page(
        'Security check',
        `<h1>Please verify</h1><iframe title="reCAPTCHA" src="about:blank" width="304" height="78"></iframe>`,
      ),
    ],
    [
      '/captcha-invisible',
      page(
        'Shop',
        `<h1>Shop</h1><iframe title="reCAPTCHA" src="about:blank#size=invisible" style="width:256px;height:60px;visibility:hidden"></iframe>`,
      ),
    ],
    ['/challenge', page('Just a moment...', '<p>Checking your browser before accessing the site.</p>')],
    [
      '/prefilled',
      page(
        'Account',
        `<h1>Account</h1>
        <label>Email <input name="email" type="email" value="member@example.com"></label>
        <label>Password <input name="pw" type="password" value="hunter2-Secret!"></label>
        <label>Confirm <input name="pw2" type="password" value="hunter2-Secret!"></label>
        <label>Verification <input autocomplete="one-time-code" value="482913"></label>
        <label>Card PIN <input name="user_pin" value="7731"></label>
        <label>Shipping address <input name="shipping_address" value="1 Main St"></label>
        <label>Visible note <input name="note" value="hello world"></label>
        <p>Your code is 482913.</p>
        <div id="host"></div>
        <script>
          const root = document.getElementById('host').attachShadow({ mode: 'open' });
          root.innerHTML = '<label>Shadow secret <input type="password" value="shadow-pass-99"></label>';
        </script>
        <iframe src="${otherOrigin()}/frame-secret" width="400" height="120"></iframe>`,
      ),
    ],
    [
      '/frame-secret',
      page(
        'frame',
        `<label>Frame password <input type="password" value="frame-pass-42"></label><label>OTP <input name="otp" value="551177"></label>`,
      ),
    ],
    [
      '/iframe-login',
      page(
        'Embedded sign in',
        `<h1>Partner portal</h1><iframe src="${otherOrigin()}/login" width="500" height="300"></iframe>`,
      ),
    ],
    [
      '/long',
      page(
        '长页面',
        Array.from(
          { length: 400 },
          (_, i) => `<p>第${i}段：这是一个很长的中文段落，用来测试快照的长度上限是否生效。</p>`,
        ).join(''),
      ),
    ],
  ]);
}

/** Where each form post lands (default /home). */
const POST_REDIRECTS: Record<string, string> = {
  '/session': '/otp',
  '/step1': '/login-step2',
  '/step1-dead': '/page2',
};

async function readBody(req: import('node:http').IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
}

/** Start a site on 127.0.0.1:<random port>. `otherOrigin` feeds cross-origin iframes. */
export async function startFixtureSite(otherOrigin: () => string = () => 'http://localhost:9'): Promise<FixtureSite> {
  const submissions: FixtureSite['submissions'] = [];
  const pages = defaultPages(otherOrigin);
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!;
      if (req.method === 'POST') {
        const fields = await readBody(req);
        submissions.push({ path, fields });
        const next = POST_REDIRECTS[path] ?? '/home';
        res.writeHead(303, { location: next });
        res.end();
        return;
      }
      const html = pages.get(path);
      if (!html) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    submissions,
    pages,
    close: () =>
      new Promise<void>((resolve) => {
        // Chromium keeps connections alive; close() alone would wait for them.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
