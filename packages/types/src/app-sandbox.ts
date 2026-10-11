/**
 * Custom-component sandbox — the bridge protocol between an app's `custom`
 * card and its host (docs/specs/20261011-tables-apps-advanced.md §1, D1).
 *
 * Aligned with MCP Apps (SEP-1865): JSON-RPC 2.0 over `postMessage`, a subset
 * of its methods —
 *   component → host  `ui/initialize` (request), `ui/notifications/initialized`,
 *                     `tools/call` (request: `query.<bindingId>` /
 *                     `action.<actionId>`), `ui/notifications/size-changed`;
 *   host → component  `ui/notifications/host-context-changed`.
 * `hostContext` carries the theme, the locale and whitelisted theme variables
 * only — never who the viewer is.
 *
 * The platform owns the whole document (`buildAppSandboxDocument`): the meta
 * CSP is the first thing in `<head>`, then the theme `<style>`, then the bridge
 * prelude, and only then the component's body. Hosts load it into an inner
 * frame inside a platform proxy frame (both `sandbox="allow-scripts"`, never
 * `allow-same-origin`; the proxy's `frame-src 'none'` stops the component from
 * navigating itself), accept a message only from that inner frame, confirm
 * every `action.*` in their own UI, and rate-limit queries.
 *
 * Zero runtime dependencies (type imports from sibling contracts only): the
 * mobile app vendors this file verbatim (`apps/mobile/src/shared/app-sandbox.ts`).
 */

import type { AppActionResult, AppCardQueryResult } from './apps.js';
import type { TableFieldValueEntry } from './tables.js';

// ─── Constants ────────────────────────────────────────────

/** The MCP Apps protocol version the bridge speaks (`ui/initialize`). */
export const APP_SANDBOX_PROTOCOL_VERSION = '2025-06-18';

export const APP_SANDBOX_LIMITS = Object.freeze({
  /** A custom card's `html`, in UTF-8 bytes. */
  htmlBytes: 200 * 1024,
  /** Bindings per custom card. */
  bindings: 10,
  /** `query.*` calls one card may make per minute (the host refuses more with `rateLimited`; the gateway caps again). */
  queriesPerMinute: 60,
  /** A component → host message, in UTF-8 bytes of its JSON. */
  messageBytes: 32 * 1024,
  /** The card's `height` and every `size-changed` height are clamped to this range (CSS pixels). */
  minHeight: 80,
  maxHeight: 2400,
  /** A theme variable's value. */
  variableValueLength: 200,
});

/**
 * The component document's policy — the first element of its `<head>`. A
 * meta CSP can only narrow what the page around it allows, so in production
 * it intersects with the API's own header (whose `connect-src` admits COS
 * buckets — closed here).
 */
export const APP_SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The platform proxy frame's policy (the outer srcdoc that hosts the component
 * frame): its `frame-src 'none'` is what refuses the component frame's own
 * navigations (SEP-1865's "sandbox proxy").
 */
export const APP_SANDBOX_PROXY_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";

/** The `sandbox` attribute of both frames — scripts, nothing else. */
export const APP_SANDBOX_IFRAME_SANDBOX = 'allow-scripts';

export const APP_SANDBOX_METHODS = Object.freeze({
  initialize: 'ui/initialize',
  initialized: 'ui/notifications/initialized',
  toolsCall: 'tools/call',
  sizeChanged: 'ui/notifications/size-changed',
  hostContextChanged: 'ui/notifications/host-context-changed',
} as const);
export type AppSandboxMethod = (typeof APP_SANDBOX_METHODS)[keyof typeof APP_SANDBOX_METHODS];

/** JSON-RPC error codes: the standard ones, then the bridge's own (server range). */
export const APP_SANDBOX_ERRORS = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Over `APP_SANDBOX_LIMITS.queriesPerMinute`. */
  rateLimited: -32001,
  /** The person dismissed the host's confirmation of an action. */
  declined: -32002,
  /** Not a binding / action of this card, or not one the viewer's role may use. */
  notAllowed: -32003,
  /** The gateway refused or failed; `error.data.reason` carries its `AppActionRefusal` / failure code. */
  failed: -32004,
  /** A message over `APP_SANDBOX_LIMITS.messageBytes`. */
  tooLarge: -32005,
});

// ─── Messages ─────────────────────────────────────────────

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

/** What the component learns about its host: appearance and language, nothing about the viewer. */
export interface AppSandboxHostContext {
  theme: 'light' | 'dark';
  /** BCP 47, e.g. `zh-CN`. */
  locale: string;
  /** Whitelisted names only (`isAppSandboxThemeVariable`), values passed through `escapeCssValue`. */
  styles: { variables: Record<string, string> };
}

export interface AppSandboxInitializeParams {
  protocolVersion: string;
  appInfo?: { name: string; version: string };
  appCapabilities?: Record<string, unknown>;
}

export interface AppSandboxInitializeResult {
  protocolVersion: string;
  hostInfo: { name: string; version: string };
  hostCapabilities: Record<string, unknown>;
  hostContext: AppSandboxHostContext;
}

/** `tools/call` names: `query.<bindingId>` or `action.<actionId>` (`action.$create` = the card's `create`). */
export type AppSandboxToolName = `query.${string}` | `action.${string}`;

/** `query.<bindingId>` arguments: the next page of a records binding. */
export interface AppSandboxQueryArguments {
  cursor?: string;
}

/** `action.<actionId>` arguments: the record it acts on (`revision` for conflict checks) and input values. */
export interface AppSandboxActionArguments {
  recordId: number;
  revision?: number;
  values?: TableFieldValueEntry[];
}

/** `action.$create` arguments. */
export interface AppSandboxCreateArguments {
  values: TableFieldValueEntry[];
}

/** The reserved action id of a custom card's `create` (the same id `/actions` uses). */
export const APP_SANDBOX_CREATE_ACTION = '$create';

export type AppSandboxToolCall =
  | { kind: 'query'; bindingId: string; arguments: AppSandboxQueryArguments }
  | { kind: 'action'; actionId: string; arguments: AppSandboxActionArguments }
  | { kind: 'create'; arguments: AppSandboxCreateArguments };

/**
 * A `tools/call` result, shaped like MCP's `CallToolResult`: the gateway's
 * answer in `structuredContent` (a card-query result for `query.*`, an action
 * result for `action.*`) and the same as JSON text in `content`.
 */
export interface AppSandboxToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: AppCardQueryResult | AppActionResult;
  isError?: boolean;
}

/** A component → host message the host may act on, after `parseAppSandboxMessage`. */
export type AppSandboxClientMessage =
  | { type: 'initialize'; id: JsonRpcId; params: AppSandboxInitializeParams }
  | { type: 'initialized' }
  | { type: 'tools/call'; id: JsonRpcId; call: AppSandboxToolCall }
  | { type: 'size-changed'; height: number; width?: number };

/**
 * `ok: false` with an `id` = answer that error; with `id: null` = drop the
 * message silently (a notification, or something that is not JSON-RPC at all).
 */
export type AppSandboxParseResult =
  | { ok: true; message: AppSandboxClientMessage }
  | { ok: false; id: JsonRpcId | null; error: { code: number; message: string } };

// ─── Pure helpers: messages ───────────────────────────────

/** UTF-8 byte length without platform APIs. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

const BRIDGE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_VALUES = 100;
const MAX_CURSOR = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is JsonRpcId {
  return (typeof value === 'string' && value.length > 0 && value.length <= 100) || Number.isInteger(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function valueEntries(raw: unknown): TableFieldValueEntry[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_VALUES) return undefined;
  const entries: TableFieldValueEntry[] = [];
  for (const entry of raw) {
    if (!isObject(entry) || !isPositiveInt(entry.fieldId) || !('value' in entry)) return undefined;
    const keys = Object.keys(entry);
    if (keys.some((key) => key !== 'fieldId' && key !== 'value')) return undefined;
    entries.push({ fieldId: entry.fieldId, value: entry.value });
  }
  return entries;
}

/** A `tools/call` `name` + `arguments` → what it asks for, or the reason it is not a call this bridge answers. */
export function parseAppSandboxToolCall(
  name: unknown,
  args: unknown,
): { ok: true; call: AppSandboxToolCall } | { ok: false; code: number; message: string } {
  const invalid = (message: string) => ({ ok: false as const, code: APP_SANDBOX_ERRORS.invalidParams, message });
  if (typeof name !== 'string') return invalid('tools/call needs a name');
  const input = args === undefined ? {} : args;
  if (!isObject(input)) return invalid('tools/call arguments must be an object');
  const dot = name.indexOf('.');
  const prefix = dot > 0 ? name.slice(0, dot) : '';
  const id = dot > 0 ? name.slice(dot + 1) : '';
  if (prefix === 'query') {
    if (!BRIDGE_ID.test(id))
      return { ok: false, code: APP_SANDBOX_ERRORS.notAllowed, message: `Unknown binding "${id}"` };
    if (Object.keys(input).some((key) => key !== 'cursor')) return invalid('query.* takes only a cursor');
    if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > MAX_CURSOR)) {
      return invalid('cursor must be a string');
    }
    return {
      ok: true,
      call: {
        kind: 'query',
        bindingId: id,
        arguments: typeof input.cursor === 'string' ? { cursor: input.cursor } : {},
      },
    };
  }
  if (prefix === 'action') {
    if (id === APP_SANDBOX_CREATE_ACTION) {
      if (Object.keys(input).some((key) => key !== 'values')) return invalid('action.$create takes only values');
      const values = valueEntries(input.values);
      if (!values) return invalid('values must be a list of {fieldId, value}');
      return { ok: true, call: { kind: 'create', arguments: { values } } };
    }
    if (!BRIDGE_ID.test(id))
      return { ok: false, code: APP_SANDBOX_ERRORS.notAllowed, message: `Unknown action "${id}"` };
    if (Object.keys(input).some((key) => key !== 'recordId' && key !== 'revision' && key !== 'values')) {
      return invalid('action.* takes recordId, revision and values');
    }
    if (!isPositiveInt(input.recordId)) return invalid('recordId must be a positive integer');
    if (input.revision !== undefined && !isPositiveInt(input.revision))
      return invalid('revision must be a positive integer');
    const values = input.values === undefined ? undefined : valueEntries(input.values);
    if (input.values !== undefined && !values) return invalid('values must be a list of {fieldId, value}');
    return {
      ok: true,
      call: {
        kind: 'action',
        actionId: id,
        arguments: {
          recordId: input.recordId,
          ...(input.revision !== undefined ? { revision: input.revision as number } : {}),
          ...(values ? { values } : {}),
        },
      },
    };
  }
  return { ok: false, code: APP_SANDBOX_ERRORS.methodNotFound, message: `Unknown tool "${name}"` };
}

function clampHeight(height: number): number {
  return Math.min(APP_SANDBOX_LIMITS.maxHeight, Math.max(APP_SANDBOX_LIMITS.minHeight, Math.round(height)));
}

/**
 * Validate one message from the component frame (an object, or its JSON text
 * as a WebView delivers it). The host still checks WHO sent it (`event.source`
 * on the web, the per-open token on mobile) before calling this.
 */
export function parseAppSandboxMessage(data: unknown): AppSandboxParseResult {
  const drop = (code: number, message: string): AppSandboxParseResult => ({
    ok: false,
    id: null,
    error: { code, message },
  });
  let raw: unknown = data;
  if (typeof data === 'string') {
    if (utf8ByteLength(data) > APP_SANDBOX_LIMITS.messageBytes)
      return drop(APP_SANDBOX_ERRORS.tooLarge, 'Message too large');
    try {
      raw = JSON.parse(data);
    } catch {
      return drop(APP_SANDBOX_ERRORS.parseError, 'Not JSON');
    }
  } else {
    let text: string | undefined;
    try {
      text = JSON.stringify(data);
    } catch {
      text = undefined;
    }
    if (text === undefined) return drop(APP_SANDBOX_ERRORS.parseError, 'Not JSON');
    if (utf8ByteLength(text) > APP_SANDBOX_LIMITS.messageBytes) {
      const id = isObject(data) && isRpcId(data.id) ? data.id : null;
      return { ok: false, id, error: { code: APP_SANDBOX_ERRORS.tooLarge, message: 'Message too large' } };
    }
  }
  if (!isObject(raw) || raw.jsonrpc !== '2.0' || typeof raw.method !== 'string') {
    return drop(APP_SANDBOX_ERRORS.invalidRequest, 'Not a JSON-RPC 2.0 request or notification');
  }
  const hasId = raw.id !== undefined && raw.id !== null;
  if (hasId && !isRpcId(raw.id)) return drop(APP_SANDBOX_ERRORS.invalidRequest, 'Invalid id');
  const id = hasId ? (raw.id as JsonRpcId) : null;
  const params = raw.params === undefined ? {} : raw.params;
  const fail = (code: number, message: string): AppSandboxParseResult => ({ ok: false, id, error: { code, message } });

  switch (raw.method) {
    case APP_SANDBOX_METHODS.initialize: {
      if (id === null) return fail(APP_SANDBOX_ERRORS.invalidRequest, 'ui/initialize is a request');
      if (!isObject(params) || typeof params.protocolVersion !== 'string') {
        return fail(APP_SANDBOX_ERRORS.invalidParams, 'ui/initialize needs a protocolVersion');
      }
      return {
        ok: true,
        message: {
          type: 'initialize',
          id,
          params: {
            protocolVersion: params.protocolVersion,
            ...(isObject(params.appInfo) &&
            typeof params.appInfo.name === 'string' &&
            typeof params.appInfo.version === 'string'
              ? { appInfo: { name: params.appInfo.name, version: params.appInfo.version } }
              : {}),
          },
        },
      };
    }
    case APP_SANDBOX_METHODS.initialized:
      return id === null
        ? { ok: true, message: { type: 'initialized' } }
        : fail(APP_SANDBOX_ERRORS.invalidRequest, 'ui/notifications/initialized is a notification');
    case APP_SANDBOX_METHODS.toolsCall: {
      if (id === null) return fail(APP_SANDBOX_ERRORS.invalidRequest, 'tools/call is a request');
      if (!isObject(params)) return fail(APP_SANDBOX_ERRORS.invalidParams, 'tools/call needs params');
      const parsed = parseAppSandboxToolCall(params.name, params.arguments);
      return parsed.ok
        ? { ok: true, message: { type: 'tools/call', id, call: parsed.call } }
        : fail(parsed.code, parsed.message);
    }
    case APP_SANDBOX_METHODS.sizeChanged: {
      if (id !== null) return fail(APP_SANDBOX_ERRORS.invalidRequest, 'size-changed is a notification');
      if (!isObject(params) || typeof params.height !== 'number' || !Number.isFinite(params.height)) {
        return drop(APP_SANDBOX_ERRORS.invalidParams, 'size-changed needs a height');
      }
      const width =
        typeof params.width === 'number' && Number.isFinite(params.width) ? Math.max(0, params.width) : undefined;
      return {
        ok: true,
        message: {
          type: 'size-changed',
          height: clampHeight(params.height),
          ...(width !== undefined ? { width } : {}),
        },
      };
    }
    default:
      return fail(APP_SANDBOX_ERRORS.methodNotFound, `Unknown method "${raw.method}"`);
  }
}

export function appSandboxResult<R>(id: JsonRpcId, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: '2.0', id, result };
}

export function appSandboxError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

export function appSandboxNotification<P>(method: string, params?: P): JsonRpcNotification<P> {
  return params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params };
}

/** A `tools/call` answer from a gateway result: structured, and the same as JSON text. */
export function appSandboxToolResult(structured: AppCardQueryResult | AppActionResult): AppSandboxToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

/** The `ui/initialize` answer. */
export function appSandboxInitializeResult(
  hostContext: AppSandboxHostContext,
  hostVersion = '1',
): AppSandboxInitializeResult {
  return {
    protocolVersion: APP_SANDBOX_PROTOCOL_VERSION,
    hostInfo: { name: 'greenhouse', version: hostVersion },
    hostCapabilities: {},
    hostContext,
  };
}

// ─── Pure helpers: theme ──────────────────────────────────

/**
 * The design tokens a component may read — surfaces, text, edges, statuses,
 * accents, chart colours, the primary ramp (space-separated RGB triplets: use
 * `rgb(var(--primary-500))`), fonts, radii and text sizes. Anything else a
 * host passes is dropped.
 */
export const APP_SANDBOX_THEME_TOKENS = [
  '--t-surface-canvas',
  '--t-surface-chrome',
  '--t-surface',
  '--t-surface-card',
  '--t-surface-raised',
  '--t-surface-muted',
  '--t-surface-sunken',
  '--t-fg',
  '--t-fg-secondary',
  '--t-fg-muted',
  '--t-fg-faint',
  '--t-edge',
  '--t-edge-strong',
  '--t-primary-fg',
  '--t-primary-fg-strong',
  '--t-primary-subtle',
  '--t-primary-subtle-hover',
  '--t-primary-edge',
  '--t-primary-wash',
  '--t-focus-ring',
  '--t-success',
  '--t-success-subtle',
  '--t-success-fg',
  '--t-warning',
  '--t-warning-subtle',
  '--t-warning-fg',
  '--t-danger',
  '--t-danger-subtle',
  '--t-danger-fg',
  '--t-info',
  '--t-info-subtle',
  '--t-info-fg',
  '--t-accent-blue',
  '--t-accent-blue-subtle',
  '--t-accent-teal',
  '--t-accent-teal-subtle',
  '--t-accent-amber',
  '--t-accent-amber-subtle',
  '--t-accent-rose',
  '--t-accent-rose-subtle',
  '--t-accent-violet',
  '--t-accent-violet-subtle',
  '--t-chart-1',
  '--t-chart-2',
  '--t-chart-3',
  '--t-chart-4',
  '--t-chart-5',
  '--t-chart-6',
  '--t-chart-7',
  '--t-chart-8',
  '--primary-50',
  '--primary-100',
  '--primary-200',
  '--primary-300',
  '--primary-400',
  '--primary-500',
  '--primary-600',
  '--primary-700',
  '--primary-800',
  '--primary-900',
  '--font-sans',
  '--font-mono',
  '--radius-xs',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--text-xs',
  '--text-sm',
  '--text-base',
  '--text-lg',
  '--text-xl',
] as const;
export type AppSandboxThemeToken = (typeof APP_SANDBOX_THEME_TOKENS)[number];

/**
 * MCP Apps' standard variable names, each given the value of one of our
 * tokens — a component written for any MCP Apps host reads the same theme.
 * (`--font-sans` / `--font-mono` share the name and are tokens already.)
 */
export const APP_SANDBOX_STANDARD_VARIABLES: Readonly<Record<string, AppSandboxThemeToken>> = Object.freeze({
  '--color-background-primary': '--t-surface-card',
  '--color-background-secondary': '--t-surface-muted',
  '--color-background-tertiary': '--t-surface-sunken',
  '--color-background-info': '--t-info-subtle',
  '--color-background-danger': '--t-danger-subtle',
  '--color-background-success': '--t-success-subtle',
  '--color-background-warning': '--t-warning-subtle',
  '--color-text-primary': '--t-fg',
  '--color-text-secondary': '--t-fg-secondary',
  '--color-text-tertiary': '--t-fg-muted',
  '--color-text-disabled': '--t-fg-faint',
  '--color-text-info': '--t-info-fg',
  '--color-text-danger': '--t-danger-fg',
  '--color-text-success': '--t-success-fg',
  '--color-text-warning': '--t-warning-fg',
  '--color-border-primary': '--t-edge',
  '--color-border-secondary': '--t-edge-strong',
  '--color-border-info': '--t-info',
  '--color-border-danger': '--t-danger',
  '--color-border-success': '--t-success',
  '--color-border-warning': '--t-warning',
  '--color-ring-primary': '--t-focus-ring',
  '--border-radius-xs': '--radius-xs',
  '--border-radius-sm': '--radius-sm',
  '--border-radius-md': '--radius-md',
  '--border-radius-lg': '--radius-lg',
  '--border-radius-xl': '--radius-xl',
  '--font-text-xs-size': '--text-xs',
  '--font-text-sm-size': '--text-sm',
  '--font-text-md-size': '--text-base',
  '--font-text-lg-size': '--text-lg',
});

const THEME_TOKENS: ReadonlySet<string> = new Set(APP_SANDBOX_THEME_TOKENS);

/** Whether a component may receive `name`: one of our tokens or an MCP Apps standard alias. */
export function isAppSandboxThemeVariable(name: string): boolean {
  return THEME_TOKENS.has(name) || Object.hasOwn(APP_SANDBOX_STANDARD_VARIABLES, name);
}

/**
 * A theme value as it may sit inside a `<style>` declaration, or `null` when it
 * cannot: refused, never rewritten. Nothing that ends a declaration, a rule or
 * the element (`; { } < >`), no backslash escapes, backticks or control
 * characters, no `url(` / `expression(` / `@import`, balanced quotes, at most
 * `APP_SANDBOX_LIMITS.variableValueLength` characters. Allows what the real
 * tokens use: colours (`rgb(… / 0.12)`, hex), space-separated triplets, font
 * stacks with quotes and commas, lengths.
 */
export function escapeCssValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > APP_SANDBOX_LIMITS.variableValueLength) return null;
  // eslint-disable-next-line no-control-regex
  if (/[;{}<>\\`\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (/url\s*\(|expression\s*\(|@import/i.test(trimmed)) return null;
  const count = (quote: string) => trimmed.split(quote).length - 1;
  if (count('"') % 2 !== 0 || count("'") % 2 !== 0) return null;
  return trimmed;
}

/**
 * Keep only whitelisted names with values `escapeCssValue` accepts — the one
 * gate every variable passes before it reaches a component (the document's
 * `<style>` and every `host-context-changed`).
 */
export function sanitizeThemeVariables(variables: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(variables).sort()) {
    if (!isAppSandboxThemeVariable(name)) continue;
    const value = escapeCssValue(variables[name]);
    if (value !== null) out[name] = value;
  }
  return out;
}

/**
 * A host's theme variables: every token through `read` (web: the computed
 * style of `<html>`; mobile: its palette), plus each MCP Apps alias with the
 * value of its token. Unreadable or refused values are left out.
 */
export function appSandboxThemeVariables(
  read: (token: AppSandboxThemeToken) => string | null | undefined,
): Record<string, string> {
  const raw: Record<string, unknown> = {};
  for (const token of APP_SANDBOX_THEME_TOKENS) raw[token] = read(token);
  for (const [alias, token] of Object.entries(APP_SANDBOX_STANDARD_VARIABLES)) raw[alias] = raw[token];
  return sanitizeThemeVariables(raw);
}

// ─── The document ─────────────────────────────────────────

/**
 * The bridge prelude: runs before the component's own code. It takes WebRTC
 * away (not a control on its own — a nested srcdoc frame could get it back;
 * the CSP and the proxy frame are the controls), speaks the bridge to
 * `window.parent`, applies the host context (theme variables, `data-theme`,
 * `color-scheme`) on start and on every `host-context-changed`, reports its
 * height, and exposes a small frozen API:
 *
 *   window.greenhouse.ready                       → Promise<hostContext>
 *   window.greenhouse.query(bindingId, {cursor?}) → Promise<AppCardQueryResult>
 *   window.greenhouse.action(actionId, {recordId, revision?, values?}) → Promise<AppActionResult>
 *   window.greenhouse.create(values)              → Promise<AppActionResult>
 *   window.greenhouse.onContextChange(listener)
 *
 * Errors reject with an `Error` carrying the JSON-RPC `code` (and `data`).
 */
export const APP_SANDBOX_PRELUDE = `(function () {
  'use strict';
  var w = window;
  var doc = document;
  ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate'].forEach(function (name) {
    try { Object.defineProperty(w, name, { value: undefined, writable: false, configurable: false }); } catch (e) {
      try { w[name] = undefined; } catch (ignored) {}
    }
  });
  var host = w.parent;
  var seq = 0;
  var pending = {};
  var listeners = [];
  function post(message) { host.postMessage(message, '*'); }
  function notify(method, params) {
    post(params === undefined ? { jsonrpc: '2.0', method: method } : { jsonrpc: '2.0', method: method, params: params });
  }
  function request(method, params) {
    return new Promise(function (resolve, reject) {
      seq += 1;
      var id = 'gh-' + seq;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: '2.0', id: id, method: method, params: params });
    });
  }
  function apply(context) {
    if (!context || typeof context !== 'object') return;
    var root = doc.documentElement;
    if (context.theme === 'light' || context.theme === 'dark') {
      root.setAttribute('data-theme', context.theme);
      root.style.colorScheme = context.theme;
    }
    var variables = context.styles && context.styles.variables;
    if (variables && typeof variables === 'object') {
      Object.keys(variables).forEach(function (name) {
        if (/^--[a-z0-9-]+$/.test(name) && typeof variables[name] === 'string') root.style.setProperty(name, variables[name]);
      });
    }
    listeners.slice().forEach(function (listener) { try { listener(context); } catch (ignored) {} });
  }
  w.addEventListener('message', function (event) {
    if (event.source !== host) return;
    var message = event.data;
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && message.id !== null && Object.prototype.hasOwnProperty.call(pending, message.id)) {
      var waiter = pending[message.id];
      delete pending[message.id];
      if (message.error) {
        var failure = new Error(String(message.error.message || 'Request failed'));
        failure.code = message.error.code;
        failure.data = message.error.data;
        waiter.reject(failure);
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (message.method === 'ui/notifications/host-context-changed') apply(message.params);
  });
  var lastHeight = -1;
  function reportSize() {
    var body = doc.body;
    if (!body) return;
    var height = Math.ceil(body.getBoundingClientRect().height);
    if (height !== lastHeight) {
      lastHeight = height;
      notify('ui/notifications/size-changed', { height: height });
    }
  }
  function watchSize() {
    if (!doc.body) return;
    if (typeof w.ResizeObserver === 'function') new w.ResizeObserver(reportSize).observe(doc.body);
    reportSize();
  }
  var ready = request('ui/initialize', {
    protocolVersion: '${APP_SANDBOX_PROTOCOL_VERSION}',
    appInfo: { name: 'greenhouse-custom-card', version: '1' },
    appCapabilities: {}
  }).then(function (result) {
    var context = result && result.hostContext;
    apply(context);
    notify('ui/notifications/initialized');
    if (doc.body) watchSize(); else doc.addEventListener('DOMContentLoaded', watchSize);
    return context;
  });
  function call(name, args) {
    return ready.then(function () {
      return request('tools/call', { name: name, arguments: args || {} });
    }).then(function (result) {
      if (result && result.isError) {
        var text = result.content && result.content[0] && result.content[0].text;
        throw new Error(String(text || 'Tool call failed'));
      }
      return result ? result.structuredContent : undefined;
    });
  }
  var api = {
    ready: ready,
    query: function (bindingId, args) { return call('query.' + bindingId, args); },
    action: function (actionId, args) { return call('action.' + actionId, args); },
    create: function (values) { return call('action.$create', { values: values }); },
    onContextChange: function (listener) { if (typeof listener === 'function') listeners.push(listener); }
  };
  Object.defineProperty(w, 'greenhouse', { value: Object.freeze(api), writable: false, configurable: false });
})();`;

export interface AppSandboxDocumentInput {
  /** The card's `html` — placed in `<body>` as is (it is the component's own code). */
  html: string;
  theme: 'light' | 'dark';
  /** Passed through `sanitizeThemeVariables` (unknown names dropped, values checked). */
  variables: Readonly<Record<string, unknown>>;
}

/**
 * The component document, in the order the spec fixes: the meta CSP first in
 * `<head>` (then the DNS-prefetch off switch and the charset), the theme
 * `<style>`, the bridge prelude, and only then the component's body. Load it as
 * the inner frame's `srcdoc` (web) or the inner document of the WebView's
 * proxy page (mobile).
 */
export function buildAppSandboxDocument(input: AppSandboxDocumentInput): string {
  const theme = input.theme === 'dark' ? 'dark' : 'light';
  const variables = sanitizeThemeVariables(input.variables);
  const declarations = Object.entries(variables)
    .map(([name, value]) => `${name}:${value};`)
    .join('');
  return [
    '<!doctype html>',
    `<html data-theme="${theme}">`,
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${APP_SANDBOX_CSP}">`,
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>:root{color-scheme:${theme};${declarations}}html,body{margin:0;padding:0;background:transparent;}body{font-family:var(--font-sans, system-ui, sans-serif);color:var(--t-fg, CanvasText);}</style>`,
    `<script>${APP_SANDBOX_PRELUDE}</script>`,
    '</head>',
    '<body>',
    input.html,
    '</body>',
    '</html>',
  ].join('\n');
}
