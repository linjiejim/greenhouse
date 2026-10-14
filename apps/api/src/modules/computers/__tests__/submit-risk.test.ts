import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { SUBMIT_RISK } from '../browser.js';

describe('browser submission risk', () => {
  it('gates form buttons, sends, payments, deletes and publishing, while ordinary navigation stays readable', () => {
    const window = new Window();
    window.document.body.innerHTML =
      '<form><button id="submit">Continue</button><button id="local" type="button">Expand</button></form><a id="link">Read article</a><button id="pay">支付</button><button id="send">Send</button><button id="delete">Delete</button><button id="publish">Publish</button>';
    const classify = new Function('globalThis', `return (${SUBMIT_RISK})`)(window) as (
      this: unknown,
      submit: boolean,
    ) => boolean;
    for (const id of ['submit', 'pay', 'send', 'delete', 'publish'])
      expect(classify.call(window.document.getElementById(id), false)).toBe(true);
    for (const id of ['link', 'local']) expect(classify.call(window.document.getElementById(id), false)).toBe(false);
    expect(classify.call(window.document.getElementById('local'), true)).toBe(true);
  });

  it('allows only the exact vault-approved login form and still gates a payment button', () => {
    const window = new Window();
    window.document.body.innerHTML =
      '<form id="login"><input type="password"><button id="signin">Sign in</button><button id="pay">Pay</button></form><form><button id="other">Sign in</button></form>';
    const form = window.document.getElementById('login') as unknown as HTMLFormElement;
    Object.assign(window, { __greenhouseApprovedLoginForm: { form, action: form.action, method: form.method } });
    const classify = new Function('globalThis', `return (${SUBMIT_RISK})`)(window) as (
      this: unknown,
      submit: boolean,
    ) => boolean;
    expect(classify.call(window.document.getElementById('signin'), true)).toBe(false);
    expect(classify.call(window.document.getElementById('pay'), false)).toBe(true);
    expect(classify.call(window.document.getElementById('other'), false)).toBe(true);
    form.action = '/pay';
    expect(classify.call(window.document.getElementById('signin'), true)).toBe(true);
  });
});
