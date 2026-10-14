/**
 * An E2B-protocol provider in memory: the control plane at api.<domain> and each sandbox's envd
 * at 49983-<id>.<domain>, answering the adapter's fetch; the bridges behind its edge are the real
 * gh-bridge processes of gh-bridge-harness.ts. Root scripts are recognised, not run: the boot
 * script and a restart write the bridge secrets they were given, as the real ones do.
 */

import { Buffer } from 'node:buffer';
import { writeFileSync } from 'node:fs';
import type { Connector } from '../sandbox/e2b/bridge.js';
import { RESET_SCRIPT } from '../sandbox/e2b/adapter.js';
import { EGRESS_APPLY_SCRIPT } from '../sandbox/e2b/egress.js';
import type { BridgeHarness } from './gh-bridge-harness.js';

export interface FakeSandbox {
  id: string;
  state: 'running' | 'paused';
  templateID: string;
  metadata: Record<string, string>;
}

export type RootKind = 'egress' | 'boot' | 'resume' | 'secrets' | 'reset' | 'exec';

export interface RootCall {
  sandbox: string;
  kind: RootKind;
  user: string;
  argv: string[];
  envs: Record<string, string>;
}

export interface RootAnswer {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Never ends: the caller's deadline has to. */
  hang?: boolean;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function frame(message: unknown, flags = 0): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(5);
  head.writeUInt8(flags, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

function kindOf(argv: string[]): RootKind {
  const script = argv[argv.indexOf('-c') + 1] ?? '';
  if (script === EGRESS_APPLY_SCRIPT) return 'egress';
  if (script === RESET_SCRIPT) return 'reset';
  if (script === '/usr/local/sbin/gh-e2b-boot') return 'boot';
  if (script === '/usr/local/sbin/gh-e2b-boot --resume') return 'resume';
  if (script === '/usr/local/sbin/gh-e2b-boot --secrets-only') return 'secrets';
  return 'exec';
}

export class FakeE2b {
  readonly networks: Array<{ id: string; allowOut?: string[]; denyOut: string[] }> = [];
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly requests: Array<{ method: string; url: URL; headers: Headers }> = [];
  readonly creates: Array<Record<string, any>> = [];
  readonly roots: RootCall[] = [];
  readonly timeouts: Array<{ id: string; seconds: number }> = [];
  readonly signals: Array<{ id: string; pid: number; signal: unknown }> = [];
  templates: Array<Record<string, unknown>> = [
    { templateID: 'tpl1', names: ['team/gh-computer-abc'], aliases: [], buildID: 'b1', buildStatus: 'ready' },
  ];
  /** What the provider says it does on timeout (undefined: it does not say). */
  onTimeout: string | undefined = 'pause';
  /** Whether it hands out traffic tokens (keeps the ports private). */
  privatePorts = true;
  /** A domain it reports for the sandboxes' ports instead of its own. */
  sandboxDomain: string | null = null;
  /** Answers a root command; 0 and nothing by default. */
  answer: (call: RootCall) => RootAnswer = () => ({});
  /** Runs inside a create, before it answers: another process's create, a failure. */
  duringCreate: (() => Response | void) | null = null;
  /** Fails every request with this (a network that is down). */
  unreachable = false;
  private next = 1;

  constructor(
    readonly apiKey: string,
    readonly bridges: BridgeHarness,
    readonly domain = 'e2b.test',
  ) {}

  /** A sandbox that exists already (made by an earlier start or another process). */
  seed(metadata: Record<string, string>, state: FakeSandbox['state'] = 'paused'): FakeSandbox {
    const id = `sbx${this.next++}`;
    const sandbox: FakeSandbox = { id, state, templateID: 'tpl1', metadata };
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  kinds(id?: string): RootKind[] {
    return this.roots.filter((call) => !id || call.sandbox === id).map((call) => call.kind);
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const method = init.method ?? 'GET';
    this.requests.push({ method, url, headers });
    if (this.unreachable) {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }
    if (url.hostname === `api.${this.domain}`) {
      if (headers.get('x-api-key') !== this.apiKey) {
        return json({ code: 401, message: `Invalid API key ${headers.get('x-api-key') ?? ''}` }, 401);
      }
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      return this.api(method, url, body);
    }
    const envd = new RegExp(`^49983-([a-z0-9]+)\\.${this.domain.replace(/\./g, '\\.')}$`).exec(url.hostname);
    if (envd) return this.envd(envd[1]!, url, headers, init);
    return new Response('no such host', { status: 404 });
  };

  private connected(sandbox: FakeSandbox, status: number) {
    return json(
      {
        sandboxID: sandbox.id,
        templateID: sandbox.templateID,
        envdAccessToken: `envd-${sandbox.id}`,
        trafficAccessToken: this.privatePorts ? `traffic-${sandbox.id}` : null,
        domain: this.sandboxDomain,
        envdVersion: '0.5.7',
      },
      status,
    );
  }

  private api(method: string, url: URL, body: any): Response {
    const path = url.pathname;
    if (method === 'GET' && path === '/v2/sandboxes') {
      const wanted = [...new URLSearchParams(url.searchParams.get('metadata') ?? '')];
      const states = url.searchParams.getAll('state');
      const rows = [...this.sandboxes.values()].filter(
        (sandbox) =>
          wanted.every(([key, value]) => sandbox.metadata[key] === value) &&
          (!states.length || states.includes(sandbox.state)),
      );
      return json(
        rows.map((sandbox) => ({
          sandboxID: sandbox.id,
          templateID: sandbox.templateID,
          state: sandbox.state,
          metadata: sandbox.metadata,
        })),
      );
    }
    if (method === 'POST' && path === '/v2/sandboxes') {
      this.creates.push(body);
      const early = this.duringCreate?.();
      if (early) return early;
      const sandbox = this.seed(body.metadata, 'running');
      sandbox.templateID = body.templateID;
      return this.connected(sandbox, 201);
    }
    if (method === 'GET' && path === '/templates') return json(this.templates);
    const match = /^(\/v2)?\/sandboxes\/([^/]+)(\/[a-z]+)?$/.exec(path);
    const sandbox = match ? this.sandboxes.get(decodeURIComponent(match[2]!)) : undefined;
    const action = match?.[3] ?? '';
    if (!sandbox) return json({ code: 404, message: 'sandbox not found' }, 404);
    if (method === 'GET' && !action) {
      return json({
        sandboxID: sandbox.id,
        templateID: sandbox.templateID,
        state: sandbox.state,
        metadata: sandbox.metadata,
        ...(this.onTimeout ? { lifecycle: { onTimeout: this.onTimeout, autoResume: false } } : {}),
      });
    }
    if (method === 'POST' && action === '/connect') {
      const resumed = sandbox.state === 'paused';
      sandbox.state = 'running';
      return this.connected(sandbox, resumed ? 201 : 200);
    }
    if (method === 'POST' && action === '/pause') {
      if (sandbox.state === 'paused') return json({ code: 409, message: 'already paused' }, 409);
      sandbox.state = 'paused';
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && action === '/timeout') {
      this.timeouts.push({ id: sandbox.id, seconds: body.timeout });
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT' && action === '/network') {
      this.networks.push({ id: sandbox.id, ...(body as { allowOut?: string[]; denyOut: string[] }) });
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE' && !action) {
      this.sandboxes.delete(sandbox.id);
      return new Response(null, { status: 204 });
    }
    return json({ code: 400, message: `unexpected ${method} ${path}` }, 400);
  }

  private envd(id: string, url: URL, headers: Headers, init: RequestInit): Response {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox || sandbox.state !== 'running') return new Response('sandbox not found', { status: 502 });
    if (headers.get('x-access-token') !== `envd-${id}`) {
      return json({ code: 'unauthenticated', message: 'invalid access token' }, 401);
    }
    const raw = Buffer.from(init.body as Uint8Array);
    if (url.pathname === '/process.Process/SendSignal') {
      const request = JSON.parse(raw.toString());
      this.signals.push({ id, pid: request.process.pid, signal: request.signal });
      return json({});
    }
    const request = JSON.parse(raw.subarray(5).toString()) as {
      process: { cmd: string; args: string[]; envs: Record<string, string>; cwd?: string };
    };
    const user = Buffer.from((headers.get('authorization') ?? '').replace(/^Basic /, ''), 'base64')
      .toString()
      .replace(/:$/, '');
    const argv = [request.process.cmd, ...request.process.args];
    const call: RootCall = { sandbox: id, kind: kindOf(argv), user, argv, envs: request.process.envs };
    this.roots.push(call);
    if (['boot', 'resume', 'secrets', 'reset'].includes(call.kind)) {
      if (call.envs.GH_BRIDGE_SECRET_AGENT)
        writeFileSync(this.bridges.agent.secretFile, call.envs.GH_BRIDGE_SECRET_AGENT);
      if (call.envs.GH_BRIDGE_SECRET_BROWSER) {
        writeFileSync(this.bridges.browser.secretFile, call.envs.GH_BRIDGE_SECRET_BROWSER);
      }
    }
    const answer = this.answer(call);
    const signal = init.signal;
    const parts = [
      frame({ event: { start: { pid: 4242 } } }),
      ...(answer.stdout ? [frame({ event: { data: { stdout: Buffer.from(answer.stdout).toString('base64') } } })] : []),
      ...(answer.stderr ? [frame({ event: { data: { stderr: Buffer.from(answer.stderr).toString('base64') } } })] : []),
    ];
    if (!answer.hang) {
      const code = answer.exitCode ?? 0;
      parts.push(
        frame({ event: { end: { ...(code ? { exitCode: code } : {}), exited: true, status: `exit status ${code}` } } }),
        frame({}, 2),
      );
    }
    const bytes = Buffer.concat(parts);
    // Cut at an odd place, so envelopes arrive in pieces.
    const cut = Math.min(7, bytes.length);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes.subarray(0, cut)));
        controller.enqueue(new Uint8Array(bytes.subarray(cut)));
        if (!answer.hang) controller.close();
        signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/connect+json' } });
  }

  /** The edge in front of the bridges: a paused or missing sandbox, or a wrong token, gets nowhere. */
  connector(seen?: Array<{ url: string; headers: Record<string, string> }>): Connector {
    const inner = this.bridges.connector();
    return (url, headers) => {
      seen?.push({ url, headers });
      const id = /^768[12]-([a-z0-9]+)\./.exec(new URL(url).hostname)?.[1] ?? '';
      const sandbox = this.sandboxes.get(id);
      if (!sandbox || sandbox.state !== 'running') return inner('wss://gone.invalid', headers);
      const token = headers['e2b-traffic-access-token'];
      return inner(
        url,
        token === `traffic-${id}` ? headers : { ...headers, 'x-gh-bridge-secret': 'refused-by-the-edge' },
      );
    };
  }
}
