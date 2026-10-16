import type { ExtensionInfo } from './extensions.js';
import type { OperationSwitches } from './operations.js';
import type { AdoptInput, Metrics } from './metrics.js';
import type { SaveMediaInput } from './media.js';
import type { KnowledgeFile } from './knowledge.js';
/**
 * The typed client of API v2, shared by the web app, the browser extension and the desktop
 * shell. It attaches the access token, refreshes it once when it expires (one refresh at a
 * time, however many requests failed), and turns the error envelope into ApiClientError.
 */

import { appsApi } from './apps-client.js';
import type {
  AdminPublicAgent,
  Agent,
  AgentDetail,
  AgentMemory,
  AgentVersion,
  CreateAgentInput,
  MemoryInput,
  Publication,
  PublicationInput,
  PublicAgent,
  UpdateAgentInput,
  UpdateMemoryInput,
} from './agents.js';
import type { CLIENT_KINDS, LinkInfo, TokenPair } from './auth.js';
import type { Page } from './common.js';
import type {
  CatalogEntry,
  ConnectKeyInput,
  Connection,
  ConnectionTest,
  Connector,
  ConnectorTest,
  CreateConnectorInput,
  MyConnections,
  OAuthFinishInput,
  OAuthStart,
  ProbeResult,
  RegistryResult,
  UpdateConnectorInput,
} from './connectors.js';
import type {
  AdminComputers,
  ComputerCapacity,
  ComputerFile,
  ComputerFolder,
  ComputerJob,
  ComputerTicket,
  ComputerTicketPurpose,
  ComputerView,
} from './computers.js';
import type {
  AddMembersInput,
  Conversation,
  ConversationDetail,
  ConversationMembers,
  CreateConversationInput,
  CreateNoteInput,
  EditMessageResult,
  Feedback,
  FeedbackInput,
  MessageItem,
  Note,
  RegenerateResult,
  SendMessageInput,
  SendMessageResult,
  UpdateConversationInput,
  UpdateNoteInput,
} from './conversations.js';
import type { FileView } from './files.js';
import type { StandingApproval } from './approvals.js';
import type { SpeechInput, Transcription } from './voice.js';
import { knowledgeApi } from './knowledge-client.js';
import { tablesApi } from './tables-client.js';
import { REALTIME_SIGN_IN_AGAIN, type RealtimeEvent } from './realtime.js';
import type {
  Group,
  GroupInput,
  InviteInput,
  InviteResult,
  IssuedLink,
  Me,
  MemberAdmin,
  MemberSummary,
  UpdateMeInput,
  UpdateMemberInput,
} from './members.js';
import type {
  AdminMail,
  ConnectMailboxInput,
  Mailbox,
  MailDetail,
  MailItem,
  MailRelease,
  MailTest,
  UpdateAdminMailInput,
  UpdateMailboxInput,
} from './mail.js';
import type { Notification } from './notifications.js';
import type {
  AdminChannel,
  AdminChannels,
  ChannelInput,
  ChannelStatus,
  ChannelTest,
  NotificationSettings,
  PushDevice,
  PushDeviceList,
  PushDeviceRegistered,
  PushPrefs,
  RegisterPushDeviceInput,
  UpdateNotificationSettingsInput,
} from './channels.js';
import type {
  AdminClient,
  ConsentDecisionInput,
  ConsentRequest,
  ConsentResult,
  CreateClientInput,
  CreatedClient,
  CreatedPersonalToken,
  CreatePersonalTokenInput,
  Grant,
  PersonalToken,
  RotatedSecret,
  UpdateClientInput,
} from './oauth.js';
import type {
  AdminProviders,
  BindingInput,
  CapabilityState,
  CreateProviderInput,
  ModelChoice,
  MyProviders,
  ProviderCapability,
  ProviderInstance,
  UpdateProviderInput,
} from './providers.js';
import type { AnswerInput, NeedsYou } from './requests.js';
import type { RunDetail, RunView } from './runs.js';
import type { CreateScheduleInput, Schedule, UpdateScheduleInput } from './schedules.js';
import type { SearchKind, SearchResult } from './search.js';
import type {
  CreateSkillInput,
  NewSkillVersionInput,
  Skill,
  SkillDetail,
  SkillDownload,
  SkillListQuery,
  SkillScanDecisionInput,
  SkillStarters,
  SkillVersion,
  UpdateSkillInput,
} from './skills.js';
import type { Bootstrap, BrandingInput } from './workspace.js';
import type { CreateVaultItemInput, UpdateVaultItemInput, VaultAccess, VaultItem } from './vault.js';
import type { AdminUsage, AgentActivity, AgentUsage, Budget, BudgetInput, MyUsage, UsagePeriod } from './usage.js';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

/**
 * Where the client keeps the session. `lock` serializes refreshes across tabs that share the
 * store (a refresh token is single-use: two tabs spending the same one would end the session).
 */
export interface TokenStore {
  get(): TokenPair | null;
  set(tokens: TokenPair | null): void;
  lock?<T>(run: () => Promise<T>): Promise<T>;
}

export interface ApiClientOptions {
  /** Origin of the API, '' for the same origin. */
  baseUrl: string;
  tokens: TokenStore;
  /** Recorded with the session; web by default. */
  client?: (typeof CLIENT_KINDS)[number];
  fetch?: typeof fetch;
  /** The session ended (refresh refused): show sign-in. */
  onSignedOut?: () => void;
}

export type RealtimeStatus = 'connecting' | 'open' | 'closed';

export interface RealtimeHandlers {
  onEvent(event: Exclude<RealtimeEvent, { type: 'ready' }>): void;
  /** After every hello, the first and each reconnect: refetch what may have been missed. */
  onReady?(info: { reconnected: boolean }): void;
  onStatus?(status: RealtimeStatus): void;
}

export interface RealtimeOptions {
  WebSocket?: typeof WebSocket;
  minDelayMs?: number;
  maxDelayMs?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

const queryString = (query?: Query) => {
  const entries = Object.entries(query ?? {}).filter(
    (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
  );
  return entries.length
    ? `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`
    : '';
};

const runNow = <T>(run: () => Promise<T>) => run();

/** The file name of a Content-Disposition header: the UTF-8 form first, else the plain one. */
export function filenameOf(header: string | null, fallback = 'download'): string {
  const encoded = header && /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // fall back to the plain name
    }
  }
  return (header && /filename="([^"]*)"/i.exec(header)?.[1]) || fallback;
}

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let refreshing: Promise<boolean> | null = null;

  async function parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      const code = error?.code ?? (response.status >= 500 ? 'unavailable' : 'internal');
      throw new ApiClientError(response.status, code, error?.message ?? response.statusText, error?.details);
    }
    return body as T;
  }

  /**
   * Gets a new access token, one refresh at a time. When another tab already replaced the
   * token that failed, its pair is used as is. A refused refresh ends the session; a network
   * failure or a busy server keeps it.
   */
  function refresh(failed?: string): Promise<boolean> {
    refreshing ??= (options.tokens.lock ?? runNow)(async () => {
      const current = options.tokens.get();
      if (!current) return false;
      if (failed && current.access_token !== failed) return true;
      try {
        const response = await doFetch(`${options.baseUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh_token: current.refresh_token }),
        });
        if (response.status === 400 || response.status === 401 || response.status === 403) {
          options.tokens.set(null);
          options.onSignedOut?.();
          return false;
        }
        if (!response.ok) return false;
        options.tokens.set((await response.json()) as TokenPair);
        return true;
      } catch {
        return false;
      }
    }).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  /** Sends with the access token, refreshing it once when it expired. */
  async function authed(
    method: string,
    path: string,
    body?: unknown,
    init: { query?: Query; raw?: BodyInit } = {},
  ): Promise<Response> {
    const send = (token: string | undefined) => {
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      return doFetch(`${options.baseUrl}${path}${queryString(init.query)}`, {
        method,
        headers,
        body: init.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
    };
    const token = options.tokens.get()?.access_token;
    const response = await send(token);
    if (response.status === 401 && token && (await refresh(token))) return send(options.tokens.get()?.access_token);
    return response;
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { query?: Query; raw?: BodyInit } = {},
  ): Promise<T> {
    return parse<T>(await authed(method, path, body, init));
  }

  /** A file the API sends as an attachment: its name and its text. */
  async function download(path: string): Promise<{ filename: string; text: string }> {
    const response = await authed('GET', path);
    if (!response.ok) return parse<never>(response);
    return { filename: filenameOf(response.headers.get('content-disposition')), text: await response.text() };
  }

  /** The same for any bytes: its name and a Blob. */
  async function downloadBlob(path: string, query?: Query): Promise<{ filename: string; blob: Blob }> {
    const response = await authed('GET', path, undefined, { query });
    if (!response.ok) return parse<never>(response);
    return { filename: filenameOf(response.headers.get('content-disposition')), blob: await response.blob() };
  }

  /**
   * The one realtime socket. It says hello with the access token, refreshes and reconnects
   * when told to sign in again, and reconnects with backoff after any other close.
   */
  function connect(handlers: RealtimeHandlers, realtime: RealtimeOptions = {}) {
    const Socket = realtime.WebSocket ?? globalThis.WebSocket;
    const minDelay = realtime.minDelayMs ?? 1_000;
    const maxDelay = realtime.maxDelayMs ?? 30_000;
    const root = (options.baseUrl || globalThis.location.origin).replace(/\/$/, '');
    const url = new URL(`${root}/api/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let stopped = false;
    let readyBefore = false;

    const schedule = (delay?: number) => {
      if (stopped) return;
      const backoff = Math.min(maxDelay, minDelay * 2 ** attempts) * (0.5 + Math.random() / 2);
      attempts += 1;
      timer = setTimeout(open, delay ?? backoff);
    };

    function open() {
      timer = null;
      if (stopped) return;
      const token = options.tokens.get()?.access_token;
      if (!token) return handlers.onStatus?.('closed');
      handlers.onStatus?.('connecting');
      const ws = new Socket(url.toString());
      socket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', data: { token } }));
      ws.onmessage = (message: MessageEvent) => {
        let event: RealtimeEvent;
        try {
          event = JSON.parse(String(message.data)) as RealtimeEvent;
        } catch {
          return;
        }
        if (event.type !== 'ready') return handlers.onEvent(event);
        attempts = 0;
        handlers.onStatus?.('open');
        handlers.onReady?.({ reconnected: readyBefore });
        readyBefore = true;
      };
      ws.onclose = (close: CloseEvent) => {
        if (socket !== ws) return;
        socket = null;
        handlers.onStatus?.('closed');
        if (stopped) return;
        if (close.code !== REALTIME_SIGN_IN_AGAIN) return schedule();
        void refresh(token).then((ok) => {
          if (ok) schedule(0);
          else if (options.tokens.get()) schedule();
        });
      };
    }

    open();
    return {
      close() {
        stopped = true;
        if (timer) clearTimeout(timer);
        const ws = socket;
        socket = null;
        ws?.close(1000);
      },
      /** Reconnect now if it is down (the network came back, the page became visible). */
      retry() {
        if (socket || stopped) return;
        if (timer) clearTimeout(timer);
        attempts = 0;
        open();
      },
    };
  }

  const get = <T>(path: string, query?: Query) => request<T>('GET', path, undefined, { query });
  const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
  const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);
  const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
  const del = (path: string) => request<void>('DELETE', path);

  return {
    request,
    refresh,
    connect,

    extensions: () => get<{ items: ExtensionInfo[] }>('/api/extensions'),
    bootstrap: () => get<Bootstrap>('/api/bootstrap'),

    auth: {
      async login(email: string, password: string): Promise<TokenPair> {
        const pair = await parse<TokenPair>(
          await doFetch(`${options.baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password, client: options.client ?? 'web' }),
          }),
        );
        options.tokens.set(pair);
        return pair;
      },
      async logout(): Promise<void> {
        const current = options.tokens.get();
        options.tokens.set(null);
        if (current) {
          await doFetch(`${options.baseUrl}/api/auth/logout`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refresh_token: current.refresh_token }),
          }).catch(() => undefined);
        }
      },
      inspectLink: (token: string) => get<LinkInfo>('/api/auth/links/inspect', { token }),
      async completeLink(token: string, password: string, name?: string): Promise<TokenPair> {
        const pair = await parse<TokenPair>(
          await doFetch(`${options.baseUrl}/api/auth/links/complete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, password, ...(name ? { name } : {}) }),
          }),
        );
        options.tokens.set(pair);
        return pair;
      },
    },

    me: {
      get: () => get<Me>('/api/me'),
      update: (input: UpdateMeInput) => patch<Me>('/api/me', input),
      changePassword: (current_password: string, new_password: string) =>
        post<void>('/api/me/password', { current_password, new_password }),
      providers: () => get<MyProviders>('/api/me/providers'),
      /** The models I may pick for an Agent, besides default, strong and fast. */
      models: () => get<{ items: ModelChoice[] }>('/api/me/models'),
      /** My own key for a capability whose policy allows it. */
      addProvider: (input: CreateProviderInput) => post<ProviderInstance>('/api/me/providers', input),
      updateProvider: (id: string, input: UpdateProviderInput) =>
        patch<ProviderInstance>(`/api/me/providers/${id}`, input),
      removeProvider: (id: string) => del(`/api/me/providers/${id}`),
      testProvider: (id: string) => post<ProviderInstance>(`/api/me/providers/${id}/test`),
      /** 设置 → 通知: only the channels I can use; fields left out of a save keep their value. */
      notificationSettings: {
        get: () => get<NotificationSettings>('/api/me/notification-settings'),
        save: (input: UpdateNotificationSettingsInput) =>
          put<NotificationSettings>('/api/me/notification-settings', input),
      },
      /** My phones (the apps register themselves; `enabled: false` means this deployment sends no pushes). */
      pushDevices: {
        list: () => get<PushDeviceList>('/api/me/push-devices'),
        register: (input: RegisterPushDeviceInput) => put<PushDeviceRegistered>('/api/me/push-devices', input),
        update: (id: string, prefs: Partial<PushPrefs>) =>
          patch<{ device: PushDevice }>(`/api/me/push-devices/${id}`, { prefs }),
        /** Disabled, never deleted: registering the phone again brings it back. */
        unregister: (id: string) => request<{ ok: true }>('DELETE', `/api/me/push-devices/${id}`),
        test: (id: string) => post<{ ok: true }>(`/api/me/push-devices/${id}/test`),
      },
      connections: {
        /** My connections, and the connectors I can use. */
        list: () => get<MyConnections>('/api/me/connections'),
        /**
         * My own key for a per_member connector (`key_rejected` when the server refuses it), or my own
         * mailbox for the built-in mailbox connector (`mailbox_rejected` when IMAP or SMTP refuses it).
         */
        connect: (input: ConnectKeyInput | ConnectMailboxInput) => post<Connection>('/api/me/connections', input),
        /** Sign in to an oauth connector: open `authorization_url`; the provider comes back to 设置 → 连接. */
        startOAuth: (connectorId: string) =>
          post<OAuthStart>('/api/me/connections/oauth/start', { connector_id: connectorId }),
        /** With `oauth_state` and `oauth_code` from the hash route the callback sent the browser to. */
        finishOAuth: (input: OAuthFinishInput) => post<Connection>('/api/me/connections/oauth/finish', input),
        test: (id: string) => post<ConnectionTest>(`/api/me/connections/${id}/test`),
        remove: (id: string) => del(`/api/me/connections/${id}`),
      },
      /** Personal access tokens for `/api/mcp` (the CLI, scripts); the token itself is shown once. */
      tokens: {
        list: (query: { cursor?: string; limit?: number } = {}) => get<Page<PersonalToken>>('/api/me/tokens', query),
        create: (input: CreatePersonalTokenInput) => post<CreatedPersonalToken>('/api/me/tokens', input),
        revoke: (id: string) => del(`/api/me/tokens/${id}`),
      },
      /** Clients I authorized; revoking one ends its tokens. */
      grants: {
        list: (query: { cursor?: string; limit?: number } = {}) => get<Page<Grant>>('/api/me/grants', query),
        /** A machine client an admin bound to me starts acting as me. */
        approve: (id: string) => post<Grant>(`/api/me/grants/${id}/approve`),
        revoke: (id: string) => del(`/api/me/grants/${id}`),
      },
      /** My logins for my Agents; values go in and never come back. */
      vault: {
        list: (query: { cursor?: string; limit?: number } = {}) => get<Page<VaultItem>>('/api/me/vault', query),
        get: (id: string) => get<VaultItem>(`/api/me/vault/${id}`),
        create: (input: CreateVaultItemInput) => post<VaultItem>('/api/me/vault', input),
        /** A value left out stays; an empty one is removed. */
        update: (id: string, input: UpdateVaultItemInput) => patch<VaultItem>(`/api/me/vault/${id}`, input),
        remove: (id: string) => del(`/api/me/vault/${id}`),
        /** What my Agents did with it, newest first. */
        log: (query: { cursor?: string; limit?: number } = {}) => get<Page<VaultAccess>>('/api/me/vault/log', query),
      },
    },

    /** The OAuth consent page, `#/oauth/consent?request=` (an `error=` there means the link itself was bad). */
    oauth: {
      consent: (request: string) => get<ConsentRequest>('/api/oauth/consent', { request }),
      /** Approve (fewer scopes if I untick some) or deny; then send the browser to `redirect_to`. */
      decide: (input: ConsentDecisionInput) => post<ConsentResult>('/api/oauth/consent', input),
    },

    members: {
      directory: (q?: string) => get<{ items: MemberSummary[] }>('/api/members', { q: q || undefined }),
      /** Every group with its member ids, for pickers (publish, share). */
      groups: () => get<{ items: Group[] }>('/api/groups'),
    },

    /** `⌘K`: conversations, messages, my Agents and people, a few of each. */
    search: (query: { q: string; kinds?: SearchKind[]; limit?: number }) =>
      get<SearchResult>('/api/search', { q: query.q, kinds: query.kinds?.join(','), limit: query.limit }),

    agents: {
      standingApprovals: (id: string, cursor?: string) =>
        get<Page<StandingApproval>>(`/api/agents/${encodeURIComponent(id)}/standing-approvals`, { cursor }),
      revokeStandingApproval: (id: string, approvalId: string) =>
        del(`/api/agents/${encodeURIComponent(id)}/standing-approvals/${encodeURIComponent(approvalId)}`),
      list: (scope: 'mine' | 'archived' = 'mine') => get<{ items: Agent[] }>('/api/agents', { scope }),
      get: (id: string) => get<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`),
      create: (input: CreateAgentInput) => post<AgentDetail>('/api/agents', input),
      update: (id: string, input: UpdateAgentInput) =>
        patch<AgentDetail>(`/api/agents/${encodeURIComponent(id)}`, input),
      archive: (id: string) => del(`/api/agents/${encodeURIComponent(id)}`),
      restore: (id: string) => post<AgentDetail>(`/api/agents/${encodeURIComponent(id)}/restore`),
      versions: (id: string) => get<{ items: AgentVersion[] }>(`/api/agents/${encodeURIComponent(id)}/versions`),
      memories: (id: string) => get<{ items: AgentMemory[] }>(`/api/agents/${encodeURIComponent(id)}/memories`),
      remember: (id: string, input: MemoryInput) =>
        post<AgentMemory>(`/api/agents/${encodeURIComponent(id)}/memories`, input),
      editMemory: (id: string, memoryId: string, input: UpdateMemoryInput) =>
        patch<AgentMemory>(`/api/agents/${encodeURIComponent(id)}/memories/${memoryId}`, input),
      forget: (id: string, memoryId: string) => del(`/api/agents/${encodeURIComponent(id)}/memories/${memoryId}`),
      computer: (id: string) => get<ComputerView>(`/api/agents/${encodeURIComponent(id)}/computer`),
      startComputer: (id: string) => post<ComputerView>(`/api/agents/${encodeURIComponent(id)}/computer/start`),
      stopComputer: (id: string) => post<ComputerView>(`/api/agents/${encodeURIComponent(id)}/computer/stop`),
      restartComputer: (id: string) => post<ComputerView>(`/api/agents/${encodeURIComponent(id)}/computer/restart`),
      processes: (id: string) =>
        get<{ items: ComputerJob[] }>(`/api/agents/${encodeURIComponent(id)}/computer/processes`),
      /** A one-time ticket for the screen (`view`, `control`) or the terminal socket, good for a minute. */
      computerTicket: (id: string, purpose: ComputerTicketPurpose) =>
        post<ComputerTicket>(`/api/agents/${encodeURIComponent(id)}/computer/ticket`, { purpose }),
      /** The URL of the screen or terminal socket, with a fresh ticket in it: open it right away. */
      async computerSocket(id: string, purpose: ComputerTicketPurpose): Promise<string> {
        const { ticket } = await post<ComputerTicket>(`/api/agents/${encodeURIComponent(id)}/computer/ticket`, {
          purpose,
        });
        const root = (options.baseUrl || globalThis.location.origin).replace(/\/$/, '');
        const url = new URL(`${root}/api/ws/${purpose === 'terminal' ? 'computer-terminal' : 'computer'}`);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('ticket', ticket);
        return url.toString();
      },
      /** A folder of the computer's home, by its path in the home ('' is the home itself). */
      files: (id: string, path = '') =>
        get<ComputerFolder>(`/api/agents/${encodeURIComponent(id)}/computer/files`, { path }),
      /** A file of the computer's home, as a download. */
      file: (id: string, path: string) =>
        downloadBlob(`/api/agents/${encodeURIComponent(id)}/computer/files/content`, { path }),
      /** Uploads into a folder of the home; a name already taken gets a number. */
      uploadFile(id: string, folder: string, file: Blob & { name?: string }) {
        const form = new FormData();
        form.set('file', file, file.name ?? 'file');
        return request<ComputerFile>('POST', `/api/agents/${encodeURIComponent(id)}/computer/files`, undefined, {
          query: { path: folder },
          raw: form,
        });
      },
      /** Deletes a file, or a folder with everything in it. */
      removeFile: (id: string, path: string) =>
        request<void>('DELETE', `/api/agents/${encodeURIComponent(id)}/computer/files`, undefined, {
          query: { path },
        }),
    },

    /** Agent 邮箱 (AGNT-30): an Agent's address, who may wake it, and its mail. Only for the Agent's owner. */
    mail: {
      /** The mailbox, made on first look; `available: false` says why there is none. */
      mailbox: (agentId: string) => get<Mailbox>(`/api/agents/${encodeURIComponent(agentId)}/mailbox`),
      /** A new address prefix, or whether workspace members may wake it. */
      updateMailbox: (agentId: string, input: UpdateMailboxInput) =>
        patch<Mailbox>(`/api/agents/${encodeURIComponent(agentId)}/mailbox`, input),
      addSender: (agentId: string, address: string) =>
        post<Mailbox>(`/api/agents/${encodeURIComponent(agentId)}/mailbox/senders`, { address }),
      removeSender: (agentId: string, address: string) =>
        request<Mailbox>(
          'DELETE',
          `/api/agents/${encodeURIComponent(agentId)}/mailbox/senders/${encodeURIComponent(address)}`,
        ),
      list: (agentId: string, query: { status?: MailItem['status']; cursor?: string; limit?: number } = {}) =>
        get<Page<MailItem>>(`/api/agents/${encodeURIComponent(agentId)}/mail`, query),
      get: (agentId: string, mailId: string) =>
        get<MailDetail>(`/api/agents/${encodeURIComponent(agentId)}/mail/${encodeURIComponent(mailId)}`),
      /** Lets a screened mail's sender in: their waiting mail goes into the thread. */
      release: (agentId: string, mailId: string) =>
        post<MailRelease>(`/api/agents/${encodeURIComponent(agentId)}/mail/${encodeURIComponent(mailId)}/release`),
    },

    conversations: {
      list: (
        query: { kind?: Conversation['kind']; q?: string; archived?: boolean; cursor?: string; limit?: number } = {},
      ) => get<Page<Conversation>>('/api/conversations', { ...query, archived: query.archived ? 'true' : undefined }),
      get: (id: string) => get<ConversationDetail>(`/api/conversations/${id}`),
      create: (input: CreateConversationInput) => post<ConversationDetail>('/api/conversations', input),
      update: (id: string, input: UpdateConversationInput) =>
        patch<ConversationDetail>(`/api/conversations/${id}`, input),
      remove: (id: string) => del(`/api/conversations/${id}`),
      messages: (id: string, query: { cursor?: string; after?: number; limit?: number } = {}) =>
        get<Page<MessageItem>>(`/api/conversations/${id}/messages`, query),
      send: (id: string, input: SendMessageInput) =>
        post<SendMessageResult>(`/api/conversations/${id}/messages`, input),
      /** My last message, new text; stop the reply first. */
      edit: (id: string, messageId: string, content: string) =>
        patch<EditMessageResult>(`/api/conversations/${id}/messages/${messageId}`, { content }),
      regenerate: (id: string, messageId: string) =>
        post<RegenerateResult>(`/api/conversations/${id}/messages/${messageId}/regenerate`),
      /** 👍 1, 👎 -1, 0 takes it back. */
      rate: (id: string, messageId: string, input: FeedbackInput) =>
        put<Feedback>(`/api/conversations/${id}/messages/${messageId}/feedback`, input),
      stop: (id: string) => post<void>(`/api/conversations/${id}/stop`),
      read: (id: string, seq: number) => post<void>(`/api/conversations/${id}/read`, { seq }),
      members: (id: string) => get<ConversationMembers>(`/api/conversations/${id}/members`),
      addMembers: (id: string, input: AddMembersInput) =>
        post<ConversationMembers>(`/api/conversations/${id}/members`, input),
      /** The owner removes someone; my own id leaves the room. */
      removeMember: (id: string, memberId: string) => del(`/api/conversations/${id}/members/${memberId}`),
      notes: (id: string, query: { cursor?: string; limit?: number } = {}) =>
        get<Page<Note>>(`/api/conversations/${id}/notes`, query),
      addNote: (id: string, input: CreateNoteInput) => post<Note>(`/api/conversations/${id}/notes`, input),
      updateNote: (id: string, noteId: string, input: UpdateNoteInput) =>
        patch<Note>(`/api/conversations/${id}/notes/${noteId}`, input),
      removeNote: (id: string, noteId: string) => del(`/api/conversations/${id}/notes/${noteId}`),
      /** The conversation as a Markdown file. */
      async export(id: string): Promise<{ filename: string; markdown: string }> {
        const file = await download(`/api/conversations/${id}/export`);
        return { filename: file.filename, markdown: file.text };
      },
    },

    requests: {
      list: (query: { state?: 'pending' | 'all'; conversation_id?: string } = {}) =>
        get<Page<NeedsYou>>('/api/requests', query),
      approve: (id: string, standing = false, continueAfter?: boolean) =>
        post<NeedsYou>(`/api/requests/${id}/approve`, {
          standing,
          ...(continueAfter !== undefined ? { continue_after: continueAfter } : {}),
        }),
      reject: (id: string, reason?: string) => post<NeedsYou>(`/api/requests/${id}/reject`, reason ? { reason } : {}),
      answer: (id: string, answers: AnswerInput['answers']) =>
        post<NeedsYou>(`/api/requests/${id}/answer`, { answers }),
      /** Hands the computer back after a take-over or a sign-in; the note is for the Agent. */
      handback: (id: string, note?: string) => post<NeedsYou>(`/api/requests/${id}/handback`, note ? { note } : {}),
    },

    runs: {
      undoWrite: (stepId: string) => post<void>(`/api/runs/steps/${encodeURIComponent(stepId)}/undo`),
      list: (query: { state?: 'active' | 'done' | 'all'; agent?: string; parent?: string; cursor?: string } = {}) =>
        get<Page<RunView> & { recent_finished?: RunView[] }>('/api/runs', query),
      get: (id: string) => get<RunDetail>(`/api/runs/${id}`),
      cancel: (id: string) => post<RunDetail>(`/api/runs/${id}/cancel`),
      retry: (id: string) => post<RunDetail>(`/api/runs/${id}/retry`),
    },

    schedules: {
      list: (agent?: string) => get<{ items: Schedule[] }>('/api/schedules', { agent }),
      create: (input: CreateScheduleInput) => post<Schedule>('/api/schedules', input),
      update: (id: string, input: UpdateScheduleInput) => patch<Schedule>(`/api/schedules/${id}`, input),
      remove: (id: string) => del(`/api/schedules/${id}`),
      pause: (id: string) => post<Schedule>(`/api/schedules/${id}/pause`),
      resume: (id: string) => post<Schedule>(`/api/schedules/${id}/resume`),
      runNow: (id: string) => post<Schedule>(`/api/schedules/${id}/run-now`),
    },

    notifications: {
      list: (query: { unread?: boolean; cursor?: string } = {}) =>
        get<Page<Notification>>('/api/notifications', { ...query, unread: query.unread ? 'true' : undefined }),
      summary: () => get<{ needs_you: number; unread: number }>('/api/notifications/summary'),
      read: (input: { ids: string[] } | { all: true }) => post<void>('/api/notifications/read', input),
    },

    usage: {
      /** My usage: this UTC month or the last 30 days. */
      mine: (period?: UsagePeriod['name']) => get<MyUsage>('/api/me/usage', { period }),
      /** One of my Agents: replies, runs, tokens, cost and ratings, never content. */
      agent: (id: string, period?: UsagePeriod['name']) =>
        get<AgentUsage>(`/api/agents/${encodeURIComponent(id)}/usage`, { period }),
      agentActivity: (id: string, query: { cursor?: string; limit?: number } = {}) =>
        get<Page<AgentActivity>>(`/api/agents/${encodeURIComponent(id)}/activity`, query),
    },

    agentBudgets: {
      list: (id: string) => get<{ items: Budget[] }>(`/api/agents/${encodeURIComponent(id)}/budgets`),
      save: (id: string, input: Omit<BudgetInput, 'scope_type' | 'scope_id'>) =>
        put<Budget>(`/api/agents/${encodeURIComponent(id)}/budgets`, { ...input, scope_type: 'agent', scope_id: id }),
    },
    publication: {
      /** Other members' public Agents shared with me; talk to one with conversations.create({ kind: 'direct' }). */
      shared: () => get<{ items: PublicAgent[] }>('/api/agents', { scope: 'public' }),
      get: (agentId: string) => get<Publication>(`/api/agents/${encodeURIComponent(agentId)}/publication`),
      /** Publish a version (default: the current one) to an audience, or change it. */
      publish: (agentId: string, input: PublicationInput) =>
        put<Publication>(`/api/agents/${encodeURIComponent(agentId)}/publication`, input),
      unpublish: (agentId: string) => del(`/api/agents/${encodeURIComponent(agentId)}/publication`),
    },

    knowledge: knowledgeApi({ get, post, patch, put, del, request, download, downloadBlob }),
    apps: appsApi({ get, post, patch, put, del, request, download, downloadBlob }),
    tables: tablesApi({ get, post, patch, put, del, request, download, downloadBlob }),

    metrics: {
      weekly: (weeks = 8) => get<Metrics>('/api/admin/usage/metrics', { weeks }),
      adopt: (input: AdoptInput) => post<void>('/api/metrics/adopt', input),
    },
    media: {
      save: (id: string, input: SaveMediaInput = {}) => post<KnowledgeFile>(`/api/media/files/${id}/save`, input),
    },
    files: {
      upload(
        file: Blob & { name?: string },
        fields: { purpose?: 'attachment' | 'avatar' | 'branding' | 'skill'; conversation_id?: string } = {},
      ) {
        const form = new FormData();
        form.set('file', file, file.name ?? 'file');
        if (fields.purpose) form.set('purpose', fields.purpose);
        if (fields.conversation_id) form.set('conversation_id', fields.conversation_id);
        return request<FileView>('POST', '/api/files', undefined, { raw: form });
      },
      get: (id: string) => get<FileView>(`/api/files/${id}`),
      remove: (id: string) => del(`/api/files/${id}`),
    },

    /** 语音: a recording to text through the STT service, text to speech through the TTS service. */
    voice: {
      transcribe(recording: Blob & { name?: string }, fields: { language?: string } = {}) {
        const form = new FormData();
        form.set('file', recording, recording.name ?? 'recording');
        if (fields.language) form.set('language', fields.language);
        return request<Transcription>('POST', '/api/voice/transcriptions', undefined, { raw: form });
      },
      /** The audio of `text`, to play. */
      async speak(input: SpeechInput): Promise<Blob> {
        const response = await authed('POST', '/api/voice/speech', input);
        if (!response.ok) return parse<never>(response);
        return response.blob();
      },
    },

    /** The skill library: team and personal skills, their versions, scan review and `/` runs. */
    skills: {
      /** `agent` (default: the main Agent) decides `available`: the `/` menu passes the answering Agent. */
      list: (query: Omit<SkillListQuery, 'archived' | 'limit'> & { archived?: boolean; limit?: number } = {}) =>
        get<Page<Skill>>('/api/skills', { ...query, archived: query.archived ? 'true' : undefined }),
      get: (id: string) => get<SkillDetail>(`/api/skills/${id}`),
      /** A template, or a package from a ZIP already uploaded with purpose `skill` (see `upload`). */
      create: (input: CreateSkillInput) => post<SkillDetail>('/api/skills', input),
      /** Uploads a ZIP with SKILL.md at its root and makes a package skill of it. */
      async upload(
        zip: Blob & { name?: string },
        input: Omit<Extract<CreateSkillInput, { kind: 'package' }>, 'kind' | 'file_id'> = {},
      ): Promise<SkillDetail> {
        const form = new FormData();
        form.set('file', zip, zip.name ?? 'skill.zip');
        form.set('purpose', 'skill');
        const file = await request<FileView>('POST', '/api/files', undefined, { raw: form });
        return post<SkillDetail>('/api/skills', { ...input, kind: 'package', file_id: file.id });
      },
      update: (id: string, input: UpdateSkillInput) => patch<Skill>(`/api/skills/${id}`, input),
      archive: (id: string) => del(`/api/skills/${id}`),
      restore: (id: string) => post<SkillDetail>(`/api/skills/${id}/restore`),
      versions: (id: string) => get<{ items: SkillVersion[] }>(`/api/skills/${id}/versions`),
      /** A new version: `file_id` of a new ZIP for a package; body, variables or requirements for a template. */
      addVersion: (id: string, input: NewSkillVersionInput) => post<SkillDetail>(`/api/skills/${id}/versions`, input),
      /** Rescan, or a reviewer's decision: safe or malicious. */
      scan: (id: string, input: SkillScanDecisionInput) => post<Skill>(`/api/skills/${id}/scan`, input),
      /** A signed URL to the package's ZIP (the latest version by default). */
      download: (id: string, version?: string) => get<SkillDownload>(`/api/skills/${id}/download`, { version }),
      /** The new chat's empty state: my three most-used skills for this Agent, else its template's starters. */
      starters: (agent?: string) => get<SkillStarters>('/api/skills/starters', { agent }),
    },

    admin: {
      /** 管理 → 服务 · 沙箱: every computer and the capacity; stop or reset one. */
      computers: {
        list: () => get<AdminComputers>('/api/admin/computers'),
        setCapacity: (input: ComputerCapacity) => put<ComputerCapacity>('/api/admin/computers/capacity', input),
        backup: (id: string) => post<void>(`/api/admin/computers/${id}/backups`),
        restore: (id: string, backup: string) => post<void>(`/api/admin/computers/${id}/backups/${backup}/restore`),
        stop: (id: string) => post<void>(`/api/admin/computers/${id}/stop`),
        reset: (id: string) => del(`/api/admin/computers/${id}`),
      },
      providers: () => get<AdminProviders>('/api/admin/providers'),
      createProvider: (input: CreateProviderInput) => post<ProviderInstance>('/api/admin/providers', input),
      updateProvider: (id: string, input: UpdateProviderInput) =>
        patch<ProviderInstance>(`/api/admin/providers/${id}`, input),
      removeProvider: (id: string) => del(`/api/admin/providers/${id}`),
      testProvider: (id: string) => post<ProviderInstance>(`/api/admin/providers/${id}/test`),
      copyProvider: (id: string) => post<ProviderInstance>(`/api/admin/providers/${id}/copy`),
      setBinding: (capability: ProviderCapability, input: BindingInput) =>
        put<CapabilityState>(`/api/admin/provider-bindings/${capability}`, input),
      /** Everyone, newest first. */
      members: (query: { cursor?: string; limit?: number } = {}) => get<Page<MemberAdmin>>('/api/admin/members', query),
      /** Invite by email: the member and a one-time activation link to hand over. */
      invite: (input: InviteInput) => post<InviteResult>('/api/admin/members', input),
      updateMember: (id: string, input: UpdateMemberInput) => patch<MemberAdmin>(`/api/admin/members/${id}`, input),
      /** A fresh activation link (invited) or reset link (active). */
      memberLink: (id: string) => post<IssuedLink>(`/api/admin/members/${id}/link`),
      groups: () => get<{ items: Group[] }>('/api/admin/groups'),
      createGroup: (input: GroupInput) => post<Group>('/api/admin/groups', input),
      saveGroup: (id: string, input: GroupInput) => put<Group>(`/api/admin/groups/${id}`, input),
      removeGroup: (id: string) => del(`/api/admin/groups/${id}`),
      branding: (input: BrandingInput) => patch<Bootstrap>('/api/admin/branding', input),
      /** The workspace's usage, grouped by member, Agent, provider or capability. */
      usage: (query: { period?: UsagePeriod['name']; group_by?: AdminUsage['group_by'] } = {}) =>
        get<AdminUsage>('/api/admin/usage', query),
      operations: {
        get: () => get<OperationSwitches>('/api/admin/operations'),
        update: (input: Partial<OperationSwitches>) => patch<OperationSwitches>('/api/admin/operations', input),
      },
      budgets: {
        list: (query: { cursor?: string; limit?: number } = {}) => get<Page<Budget>>('/api/admin/budgets', query),
        /** Creates or replaces the budget of one scope and unit. */
        save: (input: BudgetInput) => put<Budget>('/api/admin/budgets', input),
        remove: (id: string) => del(`/api/admin/budgets/${id}`),
      },
      connectors: {
        list: () => get<{ items: Connector[] }>('/api/admin/connectors'),
        get: (id: string) => get<Connector>(`/api/admin/connectors/${id}`),
        /** The built-in catalog, with the slug each entry is installed under. */
        catalog: () => get<{ items: CatalogEntry[] }>('/api/admin/connectors/catalog'),
        /** The official MCP Registry: slow, so answers are cached on the server. */
        registry: (q = '') => get<{ items: RegistryResult[] }>('/api/admin/connectors/registry', { q }),
        /** What an address asks for before it is installed. */
        probe: (url: string, transport?: Connector['transport']) =>
          post<ProbeResult>('/api/admin/connectors/probe', { url, ...(transport ? { transport } : {}) }),
        /** From the catalog (`{ catalog_id }`) or from a URL; its tools are listed at once. */
        create: (input: CreateConnectorInput) => post<Connector>('/api/admin/connectors', input),
        update: (id: string, input: UpdateConnectorInput) => patch<Connector>(`/api/admin/connectors/${id}`, input),
        remove: (id: string) => del(`/api/admin/connectors/${id}`),
        refresh: (id: string) => post<Connector>(`/api/admin/connectors/${id}/refresh`),
        test: (id: string) => post<ConnectorTest>(`/api/admin/connectors/${id}/test`),
      },
      publicAgents: {
        list: (query: { cursor?: string; limit?: number } = {}) =>
          get<Page<AdminPublicAgent>>('/api/admin/public-agents', query),
        pause: (id: string) => post<AdminPublicAgent>(`/api/admin/public-agents/${id}/pause`),
        resume: (id: string) => post<AdminPublicAgent>(`/api/admin/public-agents/${id}/resume`),
      },
      /** 管理 → 服务 → 渠道: Feishu, WeCom, push. Secrets are write-only. */
      channels: {
        list: () => get<AdminChannels>('/api/admin/channels'),
        save: <C extends AdminChannel>(channel: C, input: ChannelInput[C]) =>
          put<ChannelStatus>(`/api/admin/channels/${channel}`, input),
        /** A test message to me: my linked account, my phones. */
        test: (channel: AdminChannel) => post<ChannelTest>(`/api/admin/channels/${channel}/test`),
      },
      /** 管理 → 服务 → 邮箱: the Agent mail domain and the addresses vendors post received mail to. */
      mail: {
        get: () => get<AdminMail>('/api/admin/mail'),
        save: (input: UpdateAdminMailInput) => put<AdminMail>('/api/admin/mail', input),
        /** A test mail to me. */
        test: () => post<MailTest>('/api/admin/mail/test'),
      },
      /** External access: interactive and machine clients. */
      clients: {
        list: (query: { cursor?: string; limit?: number } = {}) => get<Page<AdminClient>>('/api/admin/clients', query),
        get: (id: string) => get<AdminClient>(`/api/admin/clients/${id}`),
        /** A machine client comes with its secret, shown once. */
        create: (input: CreateClientInput) => post<CreatedClient>('/api/admin/clients', input),
        /** Rename, disable (its tokens end at once) or enable. */
        update: (id: string, input: UpdateClientInput) => patch<AdminClient>(`/api/admin/clients/${id}`, input),
        rotateSecret: (id: string) => post<RotatedSecret>(`/api/admin/clients/${id}/rotate-secret`),
        remove: (id: string) => del(`/api/admin/clients/${id}`),
      },
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export type { AppCardAnswer } from './apps-client.js';
