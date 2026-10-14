/**
 * The Provider contract (docs/product/providers.md §5). An adapter knows one protocol or
 * vendor API; an instance is an adapter plus config plus secrets; the API resolves which
 * instance serves a capability for a member.
 */

import type { Readable, Writable } from 'node:stream';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { z } from 'zod';

export const CAPABILITIES = [
  'llm',
  'stt',
  'tts',
  'image',
  'video',
  'sandbox',
  'search',
  'storage',
  'mail',
  'im',
  'push',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface ModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
  tools?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  /** US dollars per million tokens; usage of a model without a price has no known cost. */
  price?: ModelPrice;
}

export interface ModelPrice {
  input: number;
  output: number;
  /** Input tokens read from the vendor's cache; the input price when not set. */
  cachedInput?: number;
}

export interface LlmClient {
  /** A model that only talks to this instance's endpoint. */
  languageModel(modelId: string): LanguageModelV4;
  /** Models this instance offers (from its config or preset). */
  models(): ModelInfo[];
}

export interface StoredObject {
  body: ReadableStream<Uint8Array>;
  size?: number;
  contentType?: string;
}

export interface StorageClient {
  put(key: string, body: Uint8Array, options: { contentType: string }): Promise<void>;
  /** null when the object does not exist. */
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number; contentType?: string } | null>;
  /** Idempotent: a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** A time-limited GET URL, when the backend supports it. */
  presignGet?(key: string, options: { expiresInSeconds: number; filename?: string }): string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface PageContent {
  url: string;
  title: string;
  /** Readable text or Markdown. */
  content: string;
}

export interface SearchClient {
  search(query: string, options?: { limit?: number }): Promise<SearchResult[]>;
  /** Read one page, when the provider offers a reader. */
  read?(url: string): Promise<PageContent>;
}

export interface SttClient {
  transcribe(input: { audio: Uint8Array; mimeType: string; language?: string; prompt?: string }): Promise<{
    text: string;
    durationSeconds?: number;
  }>;
}

export interface TtsClient {
  synthesize(input: { text: string; voice?: string; format?: 'mp3' | 'wav' | 'opus'; speed?: number }): Promise<{
    audio: Uint8Array;
    mimeType: string;
  }>;
}

export interface GeneratedImage {
  data: Uint8Array;
  mimeType: string;
}

export interface ImageClient {
  generate(input: { prompt: string; size?: string; n?: number }): Promise<{ images: GeneratedImage[] }>;
}

export interface SandboxSpec {
  /** One sandbox per name; the same name always reaches the same home. */
  name: string;
  labels: Record<string, string>;
  /** IANA zone the computer's clock shows. */
  timezone: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * A process or tunnel inside a computer that streams both ways: the member's terminal, the
 * screen, a file transfer. It ends when its process exits or on kill.
 */
export interface SandboxStream {
  /** Its stdin; ending it is an EOF. */
  readonly input: Writable;
  /** Its stdout, raw bytes. */
  readonly output: Readable;
  /** Its stderr, for diagnostics. */
  readonly errors: Readable;
  /** Its exit code once it ended; null when it was killed or could not start. */
  readonly exited: Promise<number | null>;
  /** Ends it now. */
  kill(): void;
}

export interface SandboxClient {
  /** Temporary background egress. Empty means offline; null restores the provider's normal rules. */
  setEgress?(name: string, domains: readonly string[] | null): Promise<void>;
  /** Starts the computer, creating it with an empty home the first time. Idempotent. */
  ensure(spec: SandboxSpec): Promise<void>;
  status(name: string): Promise<'running' | 'stopped' | 'missing'>;
  /** Runs argv inside as `user`; output past the cap is cut, and a command past its time is killed. */
  exec(
    name: string,
    input: { argv: string[]; user: 'agent' | 'root'; cwd?: string; timeoutMs: number; maxOutputBytes?: number },
  ): Promise<ExecResult>;
  /** A long-lived process as `agent` with its input and output attached; the caller ends it. */
  stream(name: string, input: { argv: string[]; user: 'agent'; cwd?: string }): SandboxStream;
  /**
   * The screen as a raw RFB byte stream. The display belongs to another user than the Agent's
   * shell, which can never reach it; only the API opens it.
   */
  screen(name: string): SandboxStream;
  /**
   * The browser's DevTools as a raw byte stream: JSON messages each ended by a NUL byte (the
   * DevTools pipe protocol). Like the screen, it belongs to the browser's user, never the
   * Agent's shell; one client at a time, and a new one replaces the last.
   */
  devtools(name: string): SandboxStream;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  /** Removes the computer; its home stays unless asked. */
  remove(name: string, options: { keepHome: boolean }): Promise<void>;
}

/** An email address with the name shown beside it. */
export interface MailAddress {
  address: string;
  name?: string;
}

/** One email to send: plain text, with an HTML alternative. */
export interface OutgoingMail {
  /** The sender; left out, the instance's own (its configured from address). */
  from?: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  text: string;
  html?: string;
  /** The Message-ID this mail answers, and the chain before it (RFC 5322), so replies thread. */
  inReplyTo?: string;
  references?: string[];
  /** Sent along where the vendor takes one, so a retried call never sends twice. */
  idempotencyKey?: string;
}

/** What the vendor said about a mail it took: its own id, and the Message-ID when it tells. */
export interface SentMail {
  providerId: string | null;
  messageId: string | null;
}

/** Channels throw it for a message that no retry can deliver: the recipient or the message is refused. */
export class UndeliverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndeliverableError';
  }
}

/** A notice whose signature does not verify (or is too old, or malformed): it is refused, never read. */
export class MailSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailSignatureError';
  }
}

/** A receiving server's verdict on one check (SPF, DKIM, DMARC); `unknown` when it said nothing usable. */
export type MailVerdict = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror' | 'unknown';

export interface InboundAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Null when it was left out: larger than the limit, past the count or the total, or not where it may be read. */
  content: Uint8Array | null;
  skipped?: 'too_large' | 'too_many' | 'unavailable';
  inline: boolean;
  /** The Content-ID an inline image is referenced by (`cid:` in the HTML). */
  contentId?: string;
}

/** A received mail in one shape whatever the vendor, fetched from the vendor's API (never from the notice). */
export interface InboundMail {
  /** The vendor's own id for it: repeated notices of the same mail dedupe on it. */
  providerMessageId: string;
  /** Message-ID, In-Reply-To and References as written, angle brackets included. */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: MailAddress;
  replyTo: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** The envelope recipients the vendor delivered it for (a Bcc lands here only). */
  recipients: string[];
  /** The envelope sender (Return-Path, MAIL FROM): what SPF checked. */
  envelopeFrom: string | null;
  subject: string;
  text: string;
  /** Unsanitised, as the sender wrote it; null when there is none or it was too large. */
  html: string | null;
  attachments: InboundAttachment[];
  /** Verdicts of the vendor's receiving server, which a sender cannot write. */
  auth: { spf: MailVerdict; dkim: MailVerdict; dmarc: MailVerdict };
  /** The domains (d=) of the DKIM signatures in the mail, to align a DKIM pass with the From domain. */
  dkimDomains: string[];
  /** ISO time the vendor received it. */
  receivedAt: string;
}

/** A webhook request as it arrived: signatures cover the exact bytes. */
export interface InboundRequest {
  headers: Headers;
  body: Uint8Array;
  /** Unix seconds; tests pin it. */
  now?: number;
}

/** What a verified notice points at. The notice is only a signal: the mail itself is fetched. */
export interface InboundNotice {
  /** The vendor's id of the mail, or the address of the stored mail at the vendor. */
  ref: string;
  /** A value the vendor sends once per notice; the API refuses to act on it twice. */
  nonce: string;
  /** How long the nonce must be remembered: notices older than this are refused anyway. */
  nonceTtlSeconds: number;
}

export interface MailReceiver {
  /** The largest notice body this vendor sends; the route refuses bigger ones unread. */
  readonly maxNoticeBytes: number;
  /**
   * Checks the vendor's signature over the raw request first; throws MailSignatureError. Null for
   * a verified notice that is not about a received mail (another event on the same webhook).
   */
  verify(request: InboundRequest): Promise<InboundNotice | null>;
  /** Fetches and normalises the mail a verified notice named, with the instance's key. */
  fetch(notice: InboundNotice): Promise<InboundMail>;
}

export interface MailClient {
  send(mail: OutgoingMail): Promise<SentMail>;
  /** Connects and signs in without sending anything. */
  verify(): Promise<void>;
  /** Present when the instance can receive: its adapter receives and its notice secret is set. */
  receive?: MailReceiver;
}

/** A workspace's app on an IM platform (Feishu, WeCom), messaging people one to one. */
export interface ImClient {
  /** Plain text to one person: a Feishu open_id, a WeCom userid. */
  sendText(to: string, text: string): Promise<void>;
  /** Gets an access token: proves the app's credentials. */
  verify(): Promise<void>;
}

/** A push as the Expo push service takes it. `projectId` groups the requests and is not sent. */
export interface PushMessage {
  to: string;
  projectId: string;
  /** Without title and body (and sound), a push only wakes the app. */
  title?: string;
  body?: string;
  data: Record<string, unknown>;
  sound?: 'default' | null;
  badge?: number;
  /** Unix seconds after which the push is dropped. */
  expiration?: number;
  priority?: 'default' | 'normal' | 'high';
  interruptionLevel?: 'active' | 'passive' | 'time-sensitive';
  /** iOS: wake the app in the background. */
  contentAvailable?: boolean;
}

/**
 * How the push service took one message: accepted (a ticket to check later), refused (`code`
 * such as DeviceNotRegistered), worth retrying (the whole request failed, maybe for now), or
 * refused for good (the request itself was malformed or unauthorised).
 */
export type PushTicket =
  | { status: 'ok'; id: string | null }
  | { status: 'error'; code: string | null; message: string }
  | { status: 'retry'; error: string }
  | { status: 'fatal'; error: string };

/** What happened to an accepted push; absent from the answer while not known yet. */
export type PushReceipt = { status: 'ok' } | { status: 'error'; code: string | null; message: string };

export interface PushClient {
  /** One ticket per message, in order. */
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
  receipts(ticketIds: readonly string[]): Promise<Record<string, PushReceipt>>;
}

export interface ClientByCapability {
  llm: LlmClient;
  stt: SttClient;
  tts: TtsClient;
  image: ImageClient;
  search: SearchClient;
  storage: StorageClient;
  video: never;
  sandbox: SandboxClient;
  mail: MailClient;
  im: ImClient;
  push: PushClient;
}

export interface ProviderPreset {
  id: string;
  label: string;
  /** Pre-filled, non-secret config (base URL, models, defaults). */
  config: Record<string, unknown>;
  docsUrl?: string;
}

export interface CreateInput<Config> {
  config: Config;
  secrets: Record<string, string>;
  /** fetch pinned to the instance endpoint; adapters must use it for every request. */
  fetch: typeof fetch;
}

export interface ProviderAdapter<C extends Capability = Capability, Config = Record<string, unknown>> {
  capability: C;
  kind: string;
  label: string;
  configSchema: z.ZodType<Config>;
  /** Secret fields; the UI writes them and nothing ever reads them back. */
  secretKeys: readonly string[];
  /** Secret fields that must be present to create a client. */
  requiredSecrets?: readonly string[];
  presets?: readonly ProviderPreset[];
  /**
   * The origins this instance may talk to. Credentials are sent nowhere else; a null entry
   * list (local disk) means no network at all.
   */
  endpoints(config: Config): string[] | null;
  create(input: CreateInput<Config>): ClientByCapability[C];
  /**
   * Mail adapters that can receive: the secret that verifies the vendor's notices. An instance
   * receives once that secret is set (its client then has `receive`).
   */
  receiveSecret?: string;
  /** The cheapest real call that proves the instance works; throws on failure. */
  test?(client: ClientByCapability[C], config: Config): Promise<void>;
  /** How long that call may take, when it is slower than the default 20 s (image generation). */
  testTimeoutMs?: number;
}

export type AnyAdapter = ProviderAdapter<Capability, any>;
