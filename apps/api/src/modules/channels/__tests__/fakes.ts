/**
 * Channel fakes for tests: a local SMTP server on a random port, and the Expo, Feishu and WeCom
 * endpoints behind the fetch the providers layer is given. Nothing reaches the internet.
 */

import { createServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { simpleParser } from 'mailparser';

export interface ReceivedMail {
  from: string;
  to: string[];
  auth: string | null;
  raw: string;
}

export interface FakeSmtp {
  port: number;
  mails: ReceivedMail[];
  /** The answer to the next DATA (e.g. '451 4.3.0 try later'); null accepts it. */
  answers: (string | null)[];
  /** RCPT TO answers by address (e.g. '550 5.1.1 no such user'). */
  refuse: Map<string, string>;
  close(): Promise<void>;
}

/** Speaks enough SMTP for nodemailer: EHLO, AUTH PLAIN or LOGIN, MAIL, RCPT, DATA, RSET, QUIT. */
export async function startFakeSmtp(): Promise<FakeSmtp> {
  const mails: ReceivedMail[] = [];
  const answers: (string | null)[] = [];
  const refuse = new Map<string, string>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    const reply = (line: string) => socket.write(`${line}\r\n`);
    let buffer = '';
    let data: string | null = null;
    let login: 'user' | 'pass' | 'plain' | null = null;
    let user = '';
    let auth: string | null = null;
    let envelope = { from: '', to: [] as string[] };
    reply('220 fake.test ESMTP');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (data !== null) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          const raw = buffer.slice(0, end).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          data = null;
          const answer = answers.shift() ?? null;
          if (answer) reply(answer);
          else {
            mails.push({ ...envelope, auth, raw });
            reply('250 2.0.0 queued');
          }
          envelope = { from: '', to: [] };
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const upper = line.toUpperCase();
        if (login) {
          const decoded = Buffer.from(line, 'base64').toString('utf8');
          if (login === 'plain') {
            auth = decoded.split('\u0000').slice(1).join(':');
            login = null;
            reply('235 2.7.0 ok');
          } else if (login === 'user') {
            user = decoded;
            login = 'pass';
            reply('334 UGFzc3dvcmQ6');
          } else {
            auth = `${user}:${decoded}`;
            login = null;
            reply('235 2.7.0 ok');
          }
        } else if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-fake.test\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          const initial = line.split(' ')[2];
          if (initial) {
            auth = Buffer.from(initial, 'base64').toString('utf8').split('\u0000').slice(1).join(':');
            reply('235 2.7.0 ok');
          } else {
            login = 'plain';
            reply('334 ');
          }
        } else if (upper.startsWith('AUTH LOGIN')) {
          const initial = line.split(' ')[2];
          if (initial) {
            user = Buffer.from(initial, 'base64').toString('utf8');
            login = 'pass';
            reply('334 UGFzc3dvcmQ6');
          } else {
            login = 'user';
            reply('334 VXNlcm5hbWU6');
          }
        } else if (upper.startsWith('MAIL FROM:')) {
          envelope.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          reply('250 2.1.0 ok');
        } else if (upper.startsWith('RCPT TO:')) {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          const refused = refuse.get(address);
          if (refused) reply(refused);
          else {
            envelope.to.push(address);
            reply('250 2.1.5 ok');
          }
        } else if (upper === 'DATA') {
          data = '';
          reply('354 go ahead');
        } else if (upper === 'RSET' || upper === 'NOOP') {
          envelope = { from: '', to: [] };
          reply('250 ok');
        } else if (upper === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else {
          reply('502 5.5.2 not implemented');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    mails,
    answers,
    refuse,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Sets up the mail capability with an SMTP instance, as an admin does in 管理 → 服务 → 邮箱;
 * email notifications go out through it. Returns its id.
 */
export async function smtpInstance(
  call: (
    method: string,
    path: string,
    options: { token?: string; body?: unknown },
  ) => Promise<{ status: number; body: any }>,
  token: string,
  config: { host: string; port?: number; security?: 'tls' | 'starttls' | 'none'; fromAddress: string },
): Promise<string> {
  const created = await call('POST', '/api/admin/providers', {
    token,
    body: { capability: 'mail', kind: 'smtp', name: 'SMTP', config, secrets: {} },
  });
  if (created.status !== 201) throw new Error(`Could not set up mail: ${JSON.stringify(created.body)}`);
  return created.body.id as string;
}

/** A received message, decoded. */
export async function readMail(mail: ReceivedMail) {
  const parsed = await simpleParser(mail.raw);
  return {
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    to: mail.to,
    from: mail.from,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Ticket = { status: 'ok'; id: string } | { status: 'error'; message: string; details: { error: string } };

/**
 * Expo, Feishu and WeCom as the fetch every provider client gets. Each records what it was sent;
 * `ticket`, `receipt`, `feishu` and `wecom` decide the answers.
 */
export function fakeNetwork() {
  let tickets = 0;
  const state = {
    pushes: [] as Record<string, unknown>[],
    /** How many send requests reached Expo (one per project and chunk). */
    pushRequests: 0,
    receiptAsks: [] as string[][],
    feishu: [] as { to: string; text: string; token: string }[],
    wecom: [] as { to: string; text: string; token: string }[],
    tokenCalls: { feishu: 0, wecom: 0 },
    ticket: (_message: Record<string, unknown>): Ticket => ({ status: 'ok', id: `ticket-${++tickets}` }),
    /** A whole send request refused: { status, body }. */
    sendFailure: null as { status: number; body: unknown } | null,
    receipt: (_id: string): Record<string, unknown> | undefined => ({ status: 'ok' }),
    /** Feishu send answer: code 0 by default. */
    feishuAnswer: () => ({ status: 200, body: { code: 0, msg: 'success' } as Record<string, unknown> }),
    wecomAnswer: () => ({
      status: 200,
      body: { errcode: 0, errmsg: 'ok', invaliduser: '' } as Record<string, unknown>,
    }),
  };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init?.headers);
    if (url.origin === 'https://exp.host' && url.pathname === '/--/api/v2/push/send') {
      state.pushRequests++;
      if (state.sendFailure) return json(state.sendFailure.body, state.sendFailure.status);
      const messages = body as Record<string, unknown>[];
      state.pushes.push(...messages);
      return json({ data: messages.map((message) => state.ticket(message)) });
    }
    if (url.origin === 'https://exp.host' && url.pathname === '/--/api/v2/push/getReceipts') {
      const ids = (body as { ids: string[] }).ids;
      state.receiptAsks.push(ids);
      const data: Record<string, unknown> = {};
      for (const id of ids) {
        const receipt = state.receipt(id);
        if (receipt) data[id] = receipt;
      }
      return json({ data });
    }
    if (url.origin === 'https://open.feishu.cn') {
      if (url.pathname === '/open-apis/auth/v3/tenant_access_token/internal') {
        state.tokenCalls.feishu++;
        return json({ code: 0, msg: 'ok', tenant_access_token: `t-${state.tokenCalls.feishu}`, expire: 7200 });
      }
      if (url.pathname === '/open-apis/im/v1/messages') {
        const answer = state.feishuAnswer();
        if (answer.body.code === 0) {
          state.feishu.push({
            to: body.receive_id,
            text: JSON.parse(body.content).text,
            token: headers.get('authorization') ?? '',
          });
        }
        return json(answer.body, answer.status);
      }
    }
    if (url.origin === 'https://qyapi.weixin.qq.com') {
      if (url.pathname === '/cgi-bin/gettoken') {
        state.tokenCalls.wecom++;
        return json({ errcode: 0, errmsg: 'ok', access_token: `w-${state.tokenCalls.wecom}`, expires_in: 7200 });
      }
      if (url.pathname === '/cgi-bin/message/send') {
        const answer = state.wecomAnswer();
        if (answer.body.errcode === 0 && !answer.body.invaliduser) {
          state.wecom.push({
            to: body.touser,
            text: body.text.content,
            token: url.searchParams.get('access_token') ?? '',
          });
        }
        return json(answer.body, answer.status);
      }
    }
    throw new Error(`The test network has no ${url.href}`);
  }) as typeof globalThis.fetch;
  return { fetch, state };
}

export const EXPO_TOKEN = (n = 1) => `ExponentPushToken[device-${n}]`;
export const PROJECT_ID = '5b1d4f3e-0c1a-4a5b-9c8d-7e6f5a4b3c2d';
