import { describe, expect, it } from 'vitest';
import { bindingProviders, bindingReturn, signInProviders } from './identity';
import { identityGlue } from './identity-registry';
import { identity as feishu } from './feishu';
import { discoverProviders } from '../login/availability';
import { en } from '../lib/i18n/en';
import { zh } from '../lib/i18n/zh';

/** A dotted key's words in a catalog (the glue and the binding page build some keys). */
const words = (catalog: unknown, key: string) =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog);

describe('provider words', () => {
  it('every provider and every binding reason the result page names has words in both languages', () => {
    const keys = [
      ...identityGlue.map((glue) => glue.title),
      ...['already_bound', 'state_expired', 'account_inactive', 'not_configured'].map((r) => `entry.bindings.${r}`),
    ];
    for (const key of keys)
      for (const catalog of [en, zh]) expect(typeof words(catalog, key), key).toBe('string');
  });
});

const CODE = 'A'.repeat(43);

describe('sign-in providers', () => {
  it('offers a provider only when the station has it configured for sign-in', () => {
    expect(signInProviders(identityGlue, [])).toEqual([]);
    expect(signInProviders(identityGlue, [{ id: 'feishu', title: 'Feishu', login: true }]).map((p) => p.id)).toEqual([
      'feishu',
    ]);
    // WeCom binds accounts but never signs anyone in; unknown providers have no glue here
    expect(
      signInProviders(identityGlue, [
        { id: 'wecom', title: 'WeCom', login: true },
        { id: 'okta', title: 'Okta', login: true },
        { id: 'feishu', title: 'Feishu', login: false },
      ]),
    ).toEqual([]);
  });

  it('reads the public discovery defensively', async () => {
    const answer = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });
    expect(await discoverProviders(answer({ providers: [{ id: 'feishu', title: 'Feishu', login: true }] }))).toEqual([
      { id: 'feishu', title: 'Feishu', login: true },
    ]);
    expect(await discoverProviders(answer({ providers: [{ id: 'wecom', title: 'WeCom', login: false }, null, 'x'] }))).toEqual([
      { id: 'wecom', title: 'WeCom', login: false },
    ]);
    expect(await discoverProviders(answer(null, false))).toEqual([]);
    expect(await discoverProviders(answer({ providers: 'feishu' }))).toEqual([]);
  });
});

describe('Feishu returns to the sign-in page', () => {
  const read = feishu.login!.read;
  it('takes a well-formed one-shot code', () => {
    expect(read(new URLSearchParams(`feishu_code=${CODE}`))).toEqual({ kind: 'code', code: CODE });
    expect(read(new URLSearchParams('feishu_code=short'))).toBeNull();
    expect(read(new URLSearchParams('feishu_code=<script>alert(1)</script>xxxxxxxxx'))).toBeNull();
  });

  it('turns an error into its reason, and anything else into nothing', () => {
    expect(read(new URLSearchParams('feishu=error&reason=not_bound'))).toEqual({ kind: 'error', reason: 'not_bound' });
    expect(feishu.login!.errorKey('not_bound')).toBe('login.feishuNotBound');
    expect(read(new URLSearchParams('feishu=ok'))).toBeNull();
    expect(read(new URLSearchParams(''))).toBeNull();
  });

  it('never starts on its own outside the Feishu app', () => {
    expect(feishu.login!.autoStart!()).toBe(false);
  });
});

describe('account bindings', () => {
  it('lists the manifest’s binding providers that have glue here', () => {
    expect(bindingProviders(identityGlue, undefined)).toEqual([]);
    expect(
      bindingProviders(identityGlue, [
        { id: 'wecom', bind: true },
        { id: 'feishu', bind: false },
        { id: 'okta', bind: true },
      ]).map((p) => p.id),
    ).toEqual(['wecom']);
  });

  it('reads a binding return for a known provider only', () => {
    expect(bindingReturn(identityGlue, new URLSearchParams('feishu=ok'))).toMatchObject({
      provider: { id: 'feishu' },
      ok: true,
    });
    expect(bindingReturn(identityGlue, new URLSearchParams('wecom=error&reason=already_bound'))).toMatchObject({
      provider: { id: 'wecom' },
      ok: false,
      reason: 'already_bound',
    });
    expect(bindingReturn(identityGlue, new URLSearchParams('okta=ok'))).toBeNull();
    expect(bindingReturn(identityGlue, new URLSearchParams('feishu=maybe'))).toBeNull();
  });
});
