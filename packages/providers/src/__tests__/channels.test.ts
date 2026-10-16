import { describe, expect, it } from 'vitest';
import { expoAdapter } from '../channels/expo.js';
import { feishuAdapter } from '../channels/feishu.js';
import { wecomAdapter } from '../channels/wecom.js';
import { EndpointViolation } from '../pinned-fetch.js';
import { UndeliverableError, type PushMessage } from '../types.js';
import { connect, json, rejection, sent } from './fake-network.js';

let apps = 0;
/** Tokens are cached per app: every test gets its own. */
const nextApp = () => `cli_test_${++apps}_${Date.now()}`;

describe('Feishu', () => {
  it('sends text to an open_id with a cached tenant token', async () => {
    const appId = nextApp();
    const { client, fake } = connect(
      feishuAdapter,
      { appId },
      (url) =>
        url.includes('tenant_access_token')
          ? json({ code: 0, tenant_access_token: 'tenant-1', expire: 7200 })
          : json({ code: 0, msg: 'success', data: { message_id: 'om_1' } }),
      { appSecret: 'feishu-secret' },
    );
    await client.sendText('ou_lin', 'Greeny：请你批准一个操作');
    await client.sendText('ou_lin', 'again');
    expect(fake.mock.calls).toHaveLength(3);
    const token = sent(fake, 0);
    expect(token.url.href).toBe('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
    expect(token.body).toEqual({ app_id: appId, app_secret: 'feishu-secret' });
    const message = sent(fake, 1);
    expect(message.url.href).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id');
    expect(message.headers.get('authorization')).toBe('Bearer tenant-1');
    expect(message.body).toEqual({
      receive_id: 'ou_lin',
      msg_type: 'text',
      content: JSON.stringify({ text: 'Greeny：请你批准一个操作' }),
    });
  });

  it('renews a token that died early, once', async () => {
    let tokens = 0;
    let sends = 0;
    const { client } = connect(
      feishuAdapter,
      { appId: nextApp() },
      (url) => {
        if (url.includes('tenant_access_token')) return json({ code: 0, tenant_access_token: `t${++tokens}` });
        return ++sends === 1 ? json({ code: 99991663, msg: 'token invalid' }, 400) : json({ code: 0 });
      },
      { appSecret: 'feishu-secret' },
    );
    await client.sendText('ou_lin', 'hi');
    expect({ tokens, sends }).toEqual({ tokens: 2, sends: 2 });
  });

  it('refuses a recipient for good, and leaves other failures to a retry without the secret', async () => {
    const { client } = connect(
      feishuAdapter,
      { appId: nextApp() },
      (url) =>
        url.includes('tenant_access_token')
          ? json({ code: 0, tenant_access_token: 'tenant-x' })
          : json({ code: 230013, msg: 'Bot has NO availability to this user.' }, 400),
      { appSecret: 'feishu-secret' },
    );
    expect(await rejection(client.sendText('ou_gone', 'hi'))).toBeInstanceOf(UndeliverableError);

    const broken = connect(
      feishuAdapter,
      { appId: nextApp() },
      () => json({ code: 10003, msg: 'invalid app_secret feishu-secret' }, 400),
      { appSecret: 'feishu-secret' },
    );
    const error = await rejection(broken.client.verify());
    expect(error).not.toBeInstanceOf(UndeliverableError);
    expect(error.message).toContain('10003');
    expect(error.message).not.toContain('feishu-secret');
  });

  it('talks to Lark when set up for it, and nowhere else', async () => {
    const lark = connect(
      feishuAdapter,
      { appId: nextApp(), baseUrl: 'https://open.larksuite.com' },
      () => json({ code: 0, tenant_access_token: 'lark-token' }),
      { appSecret: 's' },
    );
    await lark.client.verify();
    expect(sent(lark.fake).url.origin).toBe('https://open.larksuite.com');
    const pinned = connect(feishuAdapter, { appId: nextApp() }, () => json({}), { appSecret: 's' });
    // The adapter builds its URLs from the config; anything else is refused before it leaves.
    expect(feishuAdapter.endpoints(pinned.config)).toEqual(['https://open.feishu.cn']);
    expect(new EndpointViolation('https://evil.example', ['https://open.feishu.cn']).message).toContain('evil');
  });
});

describe('WeCom', () => {
  it('gets a token with the corp secret and sends text by userid', async () => {
    const corpId = nextApp();
    const { client, fake } = connect(
      wecomAdapter,
      { corpId, agentId: '1000002' },
      (url) =>
        url.includes('/gettoken')
          ? json({ errcode: 0, access_token: 'wx-token', expires_in: 7200 })
          : json({ errcode: 0, errmsg: 'ok', invaliduser: '' }),
      { secret: 'wecom-secret' },
    );
    await client.sendText('LinJie', 'hello');
    const token = sent(fake, 0);
    expect(token.url.pathname).toBe('/cgi-bin/gettoken');
    expect(token.url.searchParams.get('corpid')).toBe(corpId);
    expect(token.url.searchParams.get('corpsecret')).toBe('wecom-secret');
    const message = sent(fake, 1);
    expect(message.url.pathname).toBe('/cgi-bin/message/send');
    expect(message.url.searchParams.get('access_token')).toBe('wx-token');
    expect(message.body).toEqual({ touser: 'LinJie', msgtype: 'text', agentid: 1000002, text: { content: 'hello' } });
  });

  it('treats a send that names the user invalid as undeliverable, and renews a dead token once', async () => {
    const invalid = connect(
      wecomAdapter,
      { corpId: nextApp(), agentId: 7 },
      (url) =>
        url.includes('/gettoken')
          ? json({ errcode: 0, access_token: 'a' })
          : json({ errcode: 0, errmsg: 'ok', invaliduser: 'Nobody' }),
      { secret: 's1' },
    );
    expect(await rejection(invalid.client.sendText('Nobody', 'hi'))).toBeInstanceOf(UndeliverableError);

    let tokens = 0;
    let sends = 0;
    const renewed = connect(
      wecomAdapter,
      { corpId: nextApp(), agentId: 7 },
      (url) => {
        if (url.includes('/gettoken')) return json({ errcode: 0, access_token: `a${++tokens}` });
        return ++sends === 1 ? json({ errcode: 42001, errmsg: 'access_token expired' }) : json({ errcode: 0 });
      },
      { secret: 's2' },
    );
    await renewed.client.sendText('LinJie', 'hi');
    expect({ tokens, sends }).toEqual({ tokens: 2, sends: 2 });

    const limited = connect(
      wecomAdapter,
      { corpId: nextApp(), agentId: 7 },
      (url) => (url.includes('/gettoken') ? json({ errcode: 0, access_token: 'b' }) : json({ errcode: 45009 })),
      { secret: 's3' },
    );
    const error = await rejection(limited.client.sendText('LinJie', 'hi'));
    expect(error).not.toBeInstanceOf(UndeliverableError);
    expect(error.message).toContain('45009');
  });
});

describe('Expo', () => {
  const message = (n: number, projectId = 'project-a'): PushMessage => ({
    to: `ExponentPushToken[${n}]`,
    projectId,
    title: 'Greeny',
    body: 'Needs your approval',
    data: { v: 1, nid: `ntf_${n}` },
    contentAvailable: n === 1,
  });

  it('sends per project in chunks of 100 and answers one ticket per message, in order', async () => {
    const bodies: unknown[][] = [];
    const { client, fake } = connect(
      expoAdapter,
      {},
      (_url, init) => {
        const batch = JSON.parse(String(init.body)) as { to: string }[];
        bodies.push(batch);
        return json({
          data: batch.map((entry) =>
            entry.to === 'ExponentPushToken[2]'
              ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
              : { status: 'ok', id: `t-${entry.to}` },
          ),
        });
      },
      {},
    );
    const messages = [message(1), message(2), ...Array.from({ length: 101 }, (_, i) => message(i + 10, 'project-b'))];
    const tickets = await client.send(messages);
    expect(tickets).toHaveLength(103);
    expect(tickets[0]).toEqual({ status: 'ok', id: 't-ExponentPushToken[1]' });
    expect(tickets[1]).toEqual({ status: 'error', code: 'DeviceNotRegistered', message: 'gone' });
    expect(tickets[102]).toEqual({ status: 'ok', id: 't-ExponentPushToken[110]' });
    expect(bodies.map((batch) => batch.length).sort((a, b) => a - b)).toEqual([1, 2, 100]);
    const first = sent(fake, 0);
    expect(first.url.href).toBe('https://exp.host/--/api/v2/push/send');
    expect(first.headers.get('authorization')).toBeNull();
    // The project stays here; content-available goes out as Expo spells it.
    const wire = bodies.find((batch) => batch.length === 2)![0] as Record<string, unknown>;
    expect(wire).not.toHaveProperty('projectId');
    expect(wire).toMatchObject({ _contentAvailable: true, to: 'ExponentPushToken[1]' });
  });

  it('retries a busy or unreachable service and gives up on a refused request', async () => {
    const busy = connect(expoAdapter, {}, () => json({ errors: [{ code: 'TOO_MANY_REQUESTS' }] }, 429), {});
    expect(await busy.client.send([message(1)])).toEqual([{ status: 'retry', error: 'TOO_MANY_REQUESTS' }]);
    const down = connect(
      expoAdapter,
      {},
      () => {
        throw new TypeError('fetch failed');
      },
      {},
    );
    expect((await down.client.send([message(1)]))[0]).toMatchObject({ status: 'retry' });
    const refused = connect(
      expoAdapter,
      {},
      () => json({ errors: [{ code: 'UNAUTHORIZED', message: 'bad token tok-secret' }] }, 401),
      { accessToken: 'tok-secret' },
    );
    const [ticket] = await refused.client.send([message(1)]);
    expect(ticket).toMatchObject({ status: 'fatal' });
    expect(JSON.stringify(ticket)).not.toContain('tok-secret');
    expect(sent(refused.fake).headers.get('authorization')).toBe('Bearer tok-secret');
  });

  it('reads receipts, absent while not known yet', async () => {
    const { client, fake } = connect(
      expoAdapter,
      {},
      () =>
        json({
          data: {
            a: { status: 'ok' },
            b: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
          },
        }),
      {},
    );
    expect(await client.receipts(['a', 'b', 'c'])).toEqual({
      a: { status: 'ok' },
      b: { status: 'error', code: 'DeviceNotRegistered', message: 'gone' },
    });
    expect(sent(fake).url.href).toBe('https://exp.host/--/api/v2/push/getReceipts');
    expect(sent(fake).body).toEqual({ ids: ['a', 'b', 'c'] });
    await expoAdapter.test!(client, { baseUrl: 'https://exp.host' });
  });
});
