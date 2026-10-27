import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatTokens,
  formatUsd,
  formatUsdPrice,
  parsePrice,
  parseUsdInput,
  periodSince,
  recentMonths,
  usedFraction,
} from './format';
import {
  EMPTY_QUERY,
  createProblem,
  deliveryFailed,
  editable,
  linkState,
  linkUnavailable,
  statusPatch,
  visibleUsers,
} from './users-model';
import {
  clearState,
  descriptionParts,
  fieldText,
  flagChecked,
  settingGroups,
  settingsPayload,
  shownSource,
} from './settings-model';
import { clientKey, knownService, modelTarget, priceInput, priceText, serviceTarget } from './metering-model';
import { formatRate, overallCacheHitRate, sumCounts, totalsByClient, totalsByKey } from './usage-model';
import { connectorInput, draftFrom, draftReady, dropsCredentials, toolKind, toolPolicy } from './connectors-model';
import {
  DEFAULT_BRAND,
  activePreset,
  draftOf,
  logoProblem,
  normalizeHex,
  onBrand,
  presetDraft,
  tokensOf,
} from './branding-model';
import type { ManagedUser, WorkspaceSettingView } from './types';

describe('format', () => {
  it('formats money, tokens and durations', () => {
    expect(formatUsd(12_345_678)).toBe('$12.35');
    expect(formatUsd(4_200)).toBe('$0.0042');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsdPrice(0.000150001)).toBe('$0.00015');
    expect(formatTokens(1_234_567)).toBe('1.23M');
    expect(formatTokens(1_500)).toBe('1.5K');
    expect(formatTokens(12)).toBe('12');
    expect(formatDuration(1_234)).toBe('1.2s');
    expect(formatDuration(80)).toBe('80ms');
  });
  it('parses typed amounts', () => {
    expect(parseUsdInput('$12.5')).toBe(12_500_000);
    expect(parseUsdInput('0')).toBe(0);
    expect(parseUsdInput('-1')).toBeNull();
    expect(parseUsdInput('1.1234567')).toBeNull();
    expect(parsePrice(' $2.5 ')).toBe(2.5);
    expect(parsePrice('abc')).toBeNull();
    expect(usedFraction(5, 10)).toBe(0.5);
    expect(usedFraction(1, 0)).toBe(1);
    expect(usedFraction(0, 0)).toBe(0);
  });
  it('lists months and periods', () => {
    expect(recentMonths(new Date(Date.UTC(2026, 0, 15)))).toEqual([
      '2026-01',
      '2025-12',
      '2025-11',
      '2025-10',
      '2025-09',
      '2025-08',
    ]);
    const now = Date.UTC(2026, 9, 27, 12);
    expect(periodSince('', now)).toBeUndefined();
    expect(periodSince('24h', now)).toBe(new Date(now - 86_400_000).toISOString());
  });
});

const user = (over: Partial<ManagedUser>): ManagedUser => ({
  id: 'u',
  email: 'u@test.local',
  nickname: 'U',
  role: 'team',
  status: 'active',
  created_at: '2026-10-01T00:00:00Z',
  last_login_at: null,
  usage_summary: null,
  password_link: null,
  ...over,
});

describe('users model', () => {
  const users = [
    user({ id: 'a', nickname: 'Ann', email: 'ann@x.io', role: 'super', last_login_at: '2026-10-20 08:00:00+00' }),
    user({
      id: 'b',
      nickname: 'Bo',
      status: 'disabled',
      usage_summary: { total_calls: 9, today_messages: 0, month_tokens: 50, last_used_at: null },
    }),
    user({
      id: 'c',
      nickname: 'Cy',
      email: 'cy@x.io',
      usage_summary: { total_calls: 3, today_messages: 0, month_tokens: 900, last_used_at: null },
      last_login_at: '2026-10-25T08:00:00Z',
    }),
  ];
  it('searches, filters and sorts', () => {
    expect(visibleUsers(users, { ...EMPTY_QUERY, search: 'X.IO' }).map((u) => u.id)).toEqual(['a', 'c']);
    expect(visibleUsers(users, { ...EMPTY_QUERY, role: 'super' }).map((u) => u.id)).toEqual(['a']);
    expect(visibleUsers(users, { ...EMPTY_QUERY, status: 'disabled' }).map((u) => u.id)).toEqual(['b']);
    expect(visibleUsers(users, { ...EMPTY_QUERY, sort: 'month_tokens' }).map((u) => u.id)).toEqual(['c', 'b', 'a']);
    expect(visibleUsers(users, { ...EMPTY_QUERY, sort: 'total_calls' }).map((u) => u.id)).toEqual(['b', 'c', 'a']);
    expect(visibleUsers(users, { ...EMPTY_QUERY, sort: 'last_login' }).map((u) => u.id)).toEqual(['c', 'a', 'b']);
  });
  it('knows link states, capability and writes', () => {
    const link = { id: 'l', purpose: 'invite', created_at: '', sent_at: null, delivery_error: null };
    expect(linkState(user({}))).toBeNull();
    expect(
      linkState(
        user({ password_link: { ...link, expires_at: '2026-10-01T00:00:00Z', delivery_status: 'sent' } }),
        Date.UTC(2026, 9, 2),
      )?.kind,
    ).toBe('expired');
    expect(
      linkState(
        user({ password_link: { ...link, expires_at: '2026-10-09T00:00:00Z', delivery_status: 'sent' } }),
        Date.UTC(2026, 9, 2),
      )?.kind,
    ).toBe('pending');
    expect(
      linkState(user({ password_link: { ...link, expires_at: '2099-01-01', delivery_status: 'failed' } }))?.kind,
    ).toBe('failed');
    expect(linkUnavailable({ available: true })).toBeNull();
    expect(linkUnavailable({ available: false, reason: 'shared_mailbox_unconfigured' })).toBe('mailbox');
    expect(linkUnavailable({ available: false, reason: 'whatever' })).toBe('invalid');
    expect(deliveryFailed({ delivery: { status: 'failed', error: 'x' } })).toBe(true);
    expect(editable(users[0]!)).toBe(false);
    expect(createProblem({ email: 'a@b.c', nickname: '', mode: 'email_link', password: '' })).toBe('required');
    expect(createProblem({ email: 'a@b.c', nickname: 'A', mode: 'direct_password', password: 'short' })).toBe(
      'passwordShort',
    );
    expect(createProblem({ email: 'a@b.c', nickname: 'A', mode: 'email_link', password: '' })).toBeNull();
    expect(statusPatch(user({ status: 'active' }))).toEqual({ status: 'disabled' });
    expect(statusPatch(user({ status: 'disabled', role: 'external' }))).toEqual({ status: 'active', role: 'team' });
  });
});

const setting = (over: Partial<WorkspaceSettingView>): WorkspaceSettingView => ({
  key: 'llm.base_url',
  group: 'llm',
  label: 'LLM base URL',
  description: '',
  type: 'string',
  secret: false,
  env: 'LLM_BASE_URL',
  value: null,
  has_value: false,
  source: 'env',
  flag: null,
  ...over,
});

describe('settings model', () => {
  it('groups runtime settings first and keeps branding / team context out', () => {
    const groups = settingGroups([
      setting({ key: 'ext.crm.app', group: 'crm' }),
      setting({ key: 'branding.logo', group: 'branding' }),
      setting({ key: 'team_context.timezone', group: 'team_context' }),
      setting({ key: 'gateway.enabled', group: 'gateway', type: 'boolean' }),
      setting({}),
    ]);
    expect(groups.map((g) => g.group)).toEqual(['llm', 'gateway', 'crm']);
    expect(settingGroups([setting({ key: 'ext.crm.app', group: 'crm' }), setting({})], ['ext.crm.app'])).toEqual([
      { group: 'crm', settings: [expect.objectContaining({ key: 'ext.crm.app' })] },
    ]);
  });
  it('shows staged switches, sources and secret-free text', () => {
    const flag = setting({ type: 'boolean', flag: { effective: true, fallback: false } });
    expect(flagChecked(flag, undefined)).toBe(true);
    expect(flagChecked(flag, null)).toBe(false);
    expect(flagChecked(flag, false)).toBe(false);
    const stored = setting({ has_value: true, source: 'db', value: 'https://x' });
    expect(shownSource(stored, null)).toBe('env');
    expect(shownSource(setting({ env: null }), null)).toBe('none');
    expect(shownSource(stored, 'y')).toBe('db');
    expect(fieldText(stored, undefined)).toBe('https://x');
    expect(fieldText(setting({ secret: true, value: 'k', has_value: true }), undefined)).toBe('');
    expect(fieldText(setting({ type: 'json', value: { a: 1 } }), undefined)).toBe('{"a":1}');
    expect(clearState(stored, undefined)).toBe('clear');
    expect(clearState(stored, null)).toBe('undo');
    expect(clearState(setting({}), undefined)).toBeNull();
  });
  it('sends staged keys only, parsing JSON', () => {
    const views = [setting({}), setting({ key: 'x.json', type: 'json', label: 'X' })];
    expect(settingsPayload(views, { 'llm.base_url': 'https://y', 'x.json': '{"a":1}', unknown: 'z' })).toEqual({
      values: { 'llm.base_url': 'https://y', 'x.json': { a: 1 } },
    });
    expect(settingsPayload(views, { 'x.json': '{' })).toEqual({ invalid: 'X' });
    expect(settingsPayload(views, { 'x.json': '' })).toEqual({ values: { 'x.json': null } });
    expect(descriptionParts('Use `flash` here')).toEqual([
      { text: 'Use ', code: false },
      { text: 'flash', code: true },
      { text: ' here', code: false },
    ]);
  });
});

describe('metering model', () => {
  it('names services and clients', () => {
    expect(knownService('web_search')).toBe(true);
    expect(knownService('crm')).toBe(false);
    expect(clientKey('gateway')).toBe('gateway');
    expect(clientKey('')).toBe('unknown');
  });
  it('builds price bodies from typed text', () => {
    const service = {
      service: 'web_search',
      name: 'Web search',
      unit: 'call' as const,
      enabled: true,
      providers: [],
    };
    const provider = {
      provider: 'tavily',
      configured: true,
      price: 0.008,
      price_by_size: null,
      token_price: null,
      priced: true,
      source: 'config' as const,
    };
    const unit = serviceTarget(service, provider, 'Web search');
    expect(unit.name).toBe('Web search · tavily');
    expect(priceInput(unit, { input: '', output: '', cached: '', unit: priceText(unit.current.unit_price) })).toEqual({
      kind: 'service',
      target: 'web_search',
      provider: 'tavily',
      unit_price: 0.008,
    });
    const model = modelTarget({ id: 'flash', name: 'Default', configured: true, price: null, source: null });
    expect(priceInput(model, { input: '0.1', output: '0.4', cached: '', unit: '' })).toEqual({
      kind: 'model',
      target: 'flash',
      input: 0.1,
      output: 0.4,
      cached_input: null,
    });
    expect(priceInput(model, { input: '0.1', output: 'x', cached: '', unit: '' })).toBeNull();
    expect(priceInput(model, { input: '0.1', output: '1', cached: 'bad', unit: '' })).toBeNull();
    expect(priceText(0.00000015)).toBe('0');
    expect(priceText(undefined)).toBe('');
  });
});

describe('usage model', () => {
  const rows = [
    { key: 'knowledge_query', client: 'mcp', count: 3 },
    { key: 'knowledge_query', client: 'web_chat', count: 5 },
    { key: 'tables_query', client: 'mcp', count: 1 },
  ];
  it('totals by key and by client', () => {
    expect(totalsByKey(rows)).toEqual([
      {
        key: 'knowledge_query',
        total: 8,
        clients: [
          { client: 'web_chat', count: 5 },
          { client: 'mcp', count: 3 },
        ],
      },
      { key: 'tables_query', total: 1, clients: [{ client: 'mcp', count: 1 }] },
    ]);
    expect(totalsByClient(rows, [{ key: 'home', client: 'web', count: 7 }])).toEqual([
      { client: 'web', toolCalls: 0, pageOpens: 7 },
      { client: 'web_chat', toolCalls: 5, pageOpens: 0 },
      { client: 'mcp', toolCalls: 4, pageOpens: 0 },
    ]);
    expect(sumCounts(rows)).toBe(9);
    const cache = [{ model: 'm', calls: 1, input_tokens: 200, cached_tokens: 50, hit_rate: 0.25 }];
    expect(formatRate(overallCacheHitRate(cache))).toBe('25.0%');
    expect(formatRate(overallCacheHitRate([]))).toBe('—');
  });
});

describe('connectors model', () => {
  it('drafts from a catalog entry and writes only the chosen sign-in fields', () => {
    const draft = draftFrom(undefined, {
      id: 'app.linear/linear',
      slug: 'linear',
      title: 'Linear',
      title_zh: null,
      description: 'Issues',
      description_zh: '工单',
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable_http',
      auth: { mode: 'per_member', kind: 'oauth', scope: 'read' },
    });
    expect(draft).toMatchObject({
      slug: 'linear',
      name: 'Linear',
      auth_kind: 'oauth',
      catalog_id: 'app.linear/linear',
    });
    const body = connectorInput({ ...draft, shared_secret: 'ignored', oauth_client_secret: 's' });
    expect(body).toMatchObject({ auth_mode: 'per_member', auth_kind: 'oauth', auth_header: null, oauth_scope: 'read' });
    expect(body).not.toHaveProperty('shared_secret');
    expect(body).toHaveProperty('oauth_client_secret', 's');
    const keyBody = connectorInput({ ...draft, auth_mode: 'shared', auth_kind: 'key', shared_secret: 'k' });
    expect(keyBody).toMatchObject({ shared_secret: 'k', auth_header: 'Authorization', oauth_scope: null });
    expect(draftReady({ ...draft, slug: '9bad' }, false)).toBe(false);
    expect(draftReady({ ...draft, slug: '9bad' }, true)).toBe(true);
  });
  it('knows tool kinds, policies and dropped credentials', () => {
    const tools = [
      { name: 'list', read_only: true, kind: 'read' as const, enabled: true, vouched: false },
      { name: 'drop', destructive: true, kind: 'destructive' as const, enabled: false, vouched: false },
      { name: 'peek', kind: 'write' as const, enabled: true, vouched: true },
    ];
    expect(tools.map(toolKind)).toEqual(['read', 'destructive', 'read']);
    expect(toolPolicy(tools)).toEqual({
      tool_policy: { list: 'on', drop: 'off', peek: 'on' },
      vouched_read_only: ['peek'],
    });
    const existing = { url: 'https://a', auth_mode: 'shared' } as Parameters<typeof dropsCredentials>[0];
    expect(dropsCredentials(existing, { ...draftFrom(), url: 'https://a', auth_mode: 'shared' })).toBe(false);
    expect(dropsCredentials(existing, { ...draftFrom(), url: 'https://b', auth_mode: 'shared' })).toBe(true);
  });
});

describe('branding model', () => {
  it('drafts, presets and stores only what differs', () => {
    expect(normalizeHex('ea580c')).toBe('#EA580C');
    expect(normalizeHex('#12')).toBeNull();
    expect(draftOf(null)).toEqual({ brand: DEFAULT_BRAND, fontSans: '', fontMono: '', fontScale: 1, radiusScale: 1 });
    expect(tokensOf(draftOf(null), null)).toBeNull();
    expect(activePreset(draftOf(null))).toBe('greenhouse');
    const sunset = presetDraft('sunset');
    expect(activePreset(sunset)).toBe('sunset');
    expect(tokensOf(sunset, { dark: { '--t-surface': '#000000' } })).toEqual({
      brand: '#EA580C',
      fontSans: sunset.fontSans,
      radiusScale: 1.75,
      dark: { '--t-surface': '#000000' },
    });
    expect(tokensOf(draftOf({ brand: '#235d4d' }), { brand: '#235d4d' })).toEqual({ brand: '#235D4D' });
    expect(tokensOf({ ...draftOf(null), fontScale: 3 }, null)).toEqual({ fontScale: 1.2 });
  });
  it('picks readable text on the brand and checks logos', () => {
    expect(onBrand('#235D4D')).toBe('light');
    expect(onBrand('#F5F5F5')).toBe('dark');
    expect(logoProblem({ type: 'image/gif', size: 10 })).toBe('type');
    expect(logoProblem({ type: 'image/png', size: 300 * 1024 })).toBe('size');
    expect(logoProblem({ type: 'image/svg+xml', size: 1024 })).toBeNull();
  });
});
