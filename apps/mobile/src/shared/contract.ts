/**
 * GENERATED from packages/contract by scripts/vendor-mobile-contract.ts: the API v2 types and
 * constants the app uses, written out because apps/mobile cannot import @greenhouse/contract or
 * zod. Never edit this file: add names to the script and run
 * `node --import tsx scripts/vendor-mobile-contract.ts` from the repo root.
 * contract.parity.test.ts (root vitest) fails when it is stale.
 */

/** A page of a list: `{ items, next_cursor }` (cursor pagination). */
export type Page<T> = { items: T[]; next_cursor: string | null };

export type ApiErrorBody = { error: { code: string; message: string; details?: unknown } };

export type Bootstrap = {
  api_version: number;
  name: string;
  primary_color: string | null;
  logo_url: string | null;
  login_methods: Array<'password' | 'feishu'>;
  setup_pending: boolean;
};

export type TokenPair = { access_token: string; refresh_token: string; expires_in: number };

export type LinkInfo = { purpose: 'activate' | 'reset'; email: string; name: string };

export type MemberModules = { knowledge: boolean; tables: boolean; apps: boolean; computer: boolean };

export type MemberSummary = { id: string; name: string; email: string; avatar_url: string | null };

export type Me = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  role: 'admin' | 'member';
  locale: string;
  timezone: string;
  theme: 'system' | 'light' | 'dark';
  about: string;
  modules: { knowledge: boolean; tables: boolean; apps: boolean; computer: boolean };
  capabilities: Record<
    'llm' | 'stt' | 'tts' | 'image' | 'video' | 'sandbox' | 'search' | 'storage' | 'mail' | 'im' | 'push',
    boolean
  >;
};

export type UpdateMeInput = {
  name?: string | undefined;
  locale?: 'zh' | 'en' | undefined;
  timezone?: string | undefined;
  theme?: 'system' | 'light' | 'dark' | undefined;
  about?: string | undefined;
  avatar_file_id?: string | null | undefined;
};

export type AgentAvatar = { plant?: string | undefined; tint?: string | undefined };

export type Agent = {
  id: string;
  handle: string;
  name: string;
  role: string;
  description: string;
  avatar: { plant?: string | undefined; tint?: string | undefined };
  is_main: boolean;
  owner_id: string;
  visibility: 'private' | 'public';
  published_version: number | null;
  paused_at: string | null;
  template_key: string | null;
  current_version: number;
  archived_at: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentDetail = {
  id: string;
  handle: string;
  name: string;
  role: string;
  description: string;
  avatar: { plant?: string | undefined; tint?: string | undefined };
  is_main: boolean;
  owner_id: string;
  visibility: 'private' | 'public';
  published_version: number | null;
  paused_at: string | null;
  template_key: string | null;
  current_version: number;
  archived_at: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
  instructions: string;
  model: string;
  skills: Array<string>;
  connectors: Array<string> | null;
  tools: Array<string> | null;
  write: boolean;
  conversation_id: string | null;
};

export type PublicAgent = {
  id: string;
  handle: string;
  name: string;
  role: string;
  description: string;
  avatar: { plant?: string | undefined; tint?: string | undefined };
  is_main: boolean;
  owner_id: string;
  visibility: 'private' | 'public';
  published_version: number | null;
  paused_at: string | null;
  template_key: string | null;
  current_version: number;
  archived_at: string | null;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
  owner: { id: string; name: string; email: string; avatar_url: string | null };
  daily_cap: number;
};

export type AgentMemory = {
  id: string;
  agent_id: string;
  title: string;
  content: string;
  category: string;
  status: 'active' | 'dormant' | 'archived' | 'superseded';
  pinned: boolean;
  source: string;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AgentUsage = {
  agent_id: string;
  period: { name: 'month' | '30d'; start: string; end: string };
  budgets: Array<{
    id: string;
    scope_type: 'member' | 'workspace' | 'provider' | 'agent';
    scope_id: string;
    scope_name: string;
    unit: 'tokens' | 'usd_micros';
    monthly_limit: number;
    enabled: boolean;
    period_start: string;
    period_end: string;
    spent: number;
    exceeded: boolean;
    created_at: string;
  }>;
  totals: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cache_hit_rate: number | null;
    tokens: number;
    stt_seconds: number;
    tts_characters: number;
    cost_micros: number;
    unpriced: number;
  };
  turns: { total: number; succeeded: number; failed: number; canceled: number; active: number };
  background_runs: { total: number; succeeded: number; failed: number; canceled: number; active: number };
  people: number;
  ratings: {
    up: number;
    down: number;
    comments: Array<{ rating: number; comment: string; version: number | null; created_at: string }>;
  };
};

export type OperationSwitches = {
  pause_background_runs: boolean;
  disable_computers: boolean;
  disable_outbound_mail: boolean;
};

export type MemoryInput = {
  title: string;
  content?: string | undefined;
  category?: 'fact' | 'preference' | 'person' | 'project' | 'procedure' | 'log' | undefined;
  pinned?: boolean | undefined;
};

export type UpdateMemoryInput = {
  title?: string | undefined;
  content?: string | undefined;
  category?: 'fact' | 'preference' | 'person' | 'project' | 'procedure' | 'log' | undefined;
  pinned?: boolean | undefined;
  status?: 'active' | 'dormant' | 'archived' | undefined;
};

export type CreateAgentInput = {
  name?: string | undefined;
  role?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  avatar?: { plant?: string | undefined; tint?: string | undefined } | undefined;
  model?: string | undefined;
  skills?: Array<string> | undefined;
  connectors?: Array<string> | null | undefined;
  tools?: Array<string> | null | undefined;
  write?: boolean | undefined;
  template_key?: string | undefined;
};

export type UpdateAgentInput = {
  name?: string | undefined;
  role?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  avatar?: { plant?: string | undefined; tint?: string | undefined } | undefined;
  model?: string | undefined;
  skills?: Array<string> | undefined;
  connectors?: Array<string> | null | undefined;
  tools?: Array<string> | null | undefined;
  write?: boolean | undefined;
  change_note?: string | undefined;
};

export type Conversation = {
  id: string;
  kind: 'main' | 'direct' | 'chat' | 'room';
  title: string;
  agent_id: string | null;
  model: string | null;
  origin: string;
  read_only: boolean;
  last_seq: number;
  last_read_seq: number;
  unread: number;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  working: boolean;
  pending_requests: number;
  last_activity_at: string;
  created_at: string;
};

export type ConversationDetail = {
  id: string;
  kind: 'main' | 'direct' | 'chat' | 'room';
  title: string;
  agent_id: string | null;
  model: string | null;
  origin: string;
  read_only: boolean;
  last_seq: number;
  last_read_seq: number;
  unread: number;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  working: boolean;
  pending_requests: number;
  last_activity_at: string;
  created_at: string;
  members: Array<{ member_id: string; role: 'member' | 'owner'; last_read_seq: number }>;
  agent_ids: Array<string>;
  digest: string;
};

export type ConversationMembers = {
  members: Array<{
    id: string;
    name: string;
    email: string;
    avatar_url: string | null;
    role: 'member' | 'owner';
    last_read_seq: number;
    joined_at: string;
  }>;
  agents: Array<{
    id: string;
    name: string;
    role: string;
    avatar: { plant?: string | undefined; tint?: string | undefined };
    owner_id: string;
  }>;
};

export type Note = {
  id: string;
  conversation_id: string;
  title: string;
  body: string;
  status: 'open' | 'done';
  pinned: boolean;
  author_member_id: string | null;
  author_agent_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateConversationInput =
  | { kind: 'direct'; agent_id: string }
  | {
      kind: 'chat';
      agent_id?: string | undefined;
      title?: string | undefined;
      model?: string | undefined;
      context?:
        | { kind: 'doc'; id: string }
        | { kind: 'record'; id: string }
        | { kind: 'run'; id: string }
        | { kind: 'agent'; id: string }
        | { kind: 'app'; id: string; page_id?: string | undefined }
        | { kind: 'page'; name: string }
        | undefined;
    }
  | {
      kind: 'room';
      title?: string | undefined;
      member_ids?: Array<string> | undefined;
      agent_ids?: Array<string> | undefined;
    };

export type UpdateConversationInput = {
  title?: string | undefined;
  model?: string | null | undefined;
  pinned?: boolean | undefined;
  archived?: boolean | undefined;
  muted?: boolean | undefined;
};

export type Message = {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'event';
  author_member_id: string | null;
  agent_id: string | null;
  content: string;
  blocks: Array<unknown>;
  attachments: Array<string>;
  quote: { message_id: string; text: string } | null;
  mentions: Array<string>;
  skill: { skill_id: string; version: string | null; variables: Record<string, string> } | null;
  citations: Array<{ kind: string; id: string; title: string; url?: string | undefined }>;
  steps: Array<{ tool: string; summary: string; status: 'failed' | 'done'; duration_ms?: number | undefined }>;
  reasoning: string | null;
  event: Record<string, unknown> | null;
  run_id: string | null;
  status: 'failed' | 'complete' | 'streaming' | 'stopped';
  edited_at: string | null;
  created_at: string;
};

export type MessageItem = {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'event';
  author_member_id: string | null;
  agent_id: string | null;
  content: string;
  blocks: Array<unknown>;
  attachments: Array<string>;
  quote: { message_id: string; text: string } | null;
  mentions: Array<string>;
  skill: { skill_id: string; version: string | null; variables: Record<string, string> } | null;
  citations: Array<{ kind: string; id: string; title: string; url?: string | undefined }>;
  steps: Array<{ tool: string; summary: string; status: 'failed' | 'done'; duration_ms?: number | undefined }>;
  reasoning: string | null;
  event: Record<string, unknown> | null;
  run_id: string | null;
  status: 'failed' | 'complete' | 'streaming' | 'stopped';
  edited_at: string | null;
  created_at: string;
  my_rating: 1 | -1 | null;
};

export type SendMessageInput = {
  content: string;
  attachments?: Array<string> | undefined;
  quote?: { message_id: string; text: string } | undefined;
  mentions?: Array<string> | undefined;
  skill?: { skill_id: string; variables?: Record<string, string> | undefined } | undefined;
  rich_blocks?: Array<string> | undefined;
};

export type SendMessageResult = {
  message: {
    id: string;
    conversation_id: string;
    seq: number;
    role: 'user' | 'assistant' | 'event';
    author_member_id: string | null;
    agent_id: string | null;
    content: string;
    blocks: Array<unknown>;
    attachments: Array<string>;
    quote: { message_id: string; text: string } | null;
    mentions: Array<string>;
    skill: { skill_id: string; version: string | null; variables: Record<string, string> } | null;
    citations: Array<{ kind: string; id: string; title: string; url?: string | undefined }>;
    steps: Array<{ tool: string; summary: string; status: 'failed' | 'done'; duration_ms?: number | undefined }>;
    reasoning: string | null;
    event: Record<string, unknown> | null;
    run_id: string | null;
    status: 'failed' | 'complete' | 'streaming' | 'stopped';
    edited_at: string | null;
    created_at: string;
  };
  run_id: string | null;
  queued: boolean;
};

export type EditMessageResult = {
  deleted_message_ids: Array<string>;
  run_id: string | null;
  queued: boolean;
  message: {
    id: string;
    conversation_id: string;
    seq: number;
    role: 'user' | 'assistant' | 'event';
    author_member_id: string | null;
    agent_id: string | null;
    content: string;
    blocks: Array<unknown>;
    attachments: Array<string>;
    quote: { message_id: string; text: string } | null;
    mentions: Array<string>;
    skill: { skill_id: string; version: string | null; variables: Record<string, string> } | null;
    citations: Array<{ kind: string; id: string; title: string; url?: string | undefined }>;
    steps: Array<{ tool: string; summary: string; status: 'failed' | 'done'; duration_ms?: number | undefined }>;
    reasoning: string | null;
    event: Record<string, unknown> | null;
    run_id: string | null;
    status: 'failed' | 'complete' | 'streaming' | 'stopped';
    edited_at: string | null;
    created_at: string;
  };
};

export type RegenerateResult = { deleted_message_ids: Array<string>; run_id: string | null; queued: boolean };

export type FeedbackInput = { rating: 0 | 1 | -1; comment?: string | undefined };

export type Feedback = { rating: 0 | 1 | -1; comment: string };

export type RealtimeEvent =
  | { type: 'ready'; data: { member_id: string } }
  | {
      type: 'message.created';
      data: {
        message: {
          id: string;
          conversation_id: string;
          seq: number;
          role: 'user' | 'assistant' | 'event';
          author_member_id: string | null;
          agent_id: string | null;
          content: string;
          blocks: Array<unknown>;
          attachments: Array<string>;
          quote: { message_id: string; text: string } | null;
          mentions: Array<string>;
          skill: { skill_id: string; version: string | null; variables: Record<string, string> } | null;
          citations: Array<{ kind: string; id: string; title: string; url?: string | undefined }>;
          steps: Array<{ tool: string; summary: string; status: 'failed' | 'done'; duration_ms?: number | undefined }>;
          reasoning: string | null;
          event: Record<string, unknown> | null;
          run_id: string | null;
          status: 'failed' | 'complete' | 'streaming' | 'stopped';
          edited_at: string | null;
          created_at: string;
        };
      };
    }
  | { type: 'message.delta'; data: { conversation_id: string; message_id: string; text: string; offset: number } }
  | {
      type: 'message.step';
      data: {
        conversation_id: string;
        message_id: string;
        step: {
          tool: string;
          summary: string;
          id: string;
          status: 'failed' | 'done' | 'running';
          duration_ms?: number | undefined;
        };
      };
    }
  | { type: 'message.resumed'; data: { conversation_id: string; message_id: string; offset: number } }
  | {
      type: 'message.updated';
      data: {
        message: {
          id: string;
          conversation_id: string;
          seq: number;
          role: 'user' | 'assistant' | 'event';
          author_member_id: string | null;
          agent_id: string | null;
          content: string;
          blocks: Array<unknown>;
          attachments: Array<string>;
          quote: { message_id: string; text: string } | null;
          mentions: Array<string>;
          skill: { skill_id: string; version: string | null; variables: Record<string, string> } | null;
          citations: Array<{ kind: string; id: string; title: string; url?: string | undefined }>;
          steps: Array<{ tool: string; summary: string; status: 'failed' | 'done'; duration_ms?: number | undefined }>;
          reasoning: string | null;
          event: Record<string, unknown> | null;
          run_id: string | null;
          status: 'failed' | 'complete' | 'streaming' | 'stopped';
          edited_at: string | null;
          created_at: string;
        };
      };
    }
  | { type: 'message.deleted'; data: { conversation_id: string; message_id: string } }
  | { type: 'conversation.resync'; data: { conversation_id: string; after_seq: number } }
  | {
      type: 'conversation.updated';
      data: {
        conversation_id: string;
        changes: {
          id?: string | undefined;
          kind?: 'main' | 'direct' | 'chat' | 'room' | undefined;
          title?: string | undefined;
          agent_id?: string | null | undefined;
          model?: string | null | undefined;
          origin?: string | undefined;
          read_only?: boolean | undefined;
          last_seq?: number | undefined;
          last_read_seq?: number | undefined;
          unread?: number | undefined;
          pinned?: boolean | undefined;
          archived?: boolean | undefined;
          muted?: boolean | undefined;
          working?: boolean | undefined;
          pending_requests?: number | undefined;
          last_activity_at?: string | undefined;
          created_at?: string | undefined;
        };
      };
    }
  | { type: 'read.updated'; data: { conversation_id: string; member_id: string; last_read_seq: number } }
  | { type: 'notes.updated'; data: { conversation_id: string; note_id: string } }
  | { type: 'run.updated'; data: { run_id: string; status: string; conversation_id: string | null } }
  | { type: 'request.updated'; data: { request_id: string; status: string; conversation_id: string | null } }
  | { type: 'notification.created'; data: { notification_id: string; kind: string; title: string } }
  | { type: 'notification.read'; data: { notification_ids: Array<string> } }
  | {
      type: 'computer.updated';
      data: { agent_id: string; state: 'failed' | 'stopped' | 'queued' | 'running' | 'starting' };
    }
  | { type: 'vault.updated'; data: { item_id: string | null } }
  | {
      type: 'doc.updated';
      data: { doc_id: string; version: number; title: string; updated_by: string | null; archived: boolean };
    }
  | {
      type: 'doc.presence';
      data: {
        doc_id: string;
        items: Array<{ member_id: string; name: string; state: 'viewing' | 'editing'; since: string }>;
      };
    }
  | {
      type: 'records.changed';
      data: {
        base_id: string;
        table_id: string;
        records: Array<{ id: string; revision: number; computed_revision?: number | undefined }>;
      };
    }
  | { type: 'base.updated'; data: { base_id: string } }
  | { type: 'comments.updated'; data: { target_type: 'record' | 'doc'; target_id: string; comment_id: string } }
  | { type: 'knowledge.changed'; data: Record<string, never> };

export type QuestionField = {
  key: string;
  label: string;
  type: 'text' | 'choice';
  required: boolean;
  options?: Array<string> | undefined;
};

export type NeedsYou = {
  id: string;
  kind: 'approval' | 'login' | 'takeover' | 'question' | 'proposal';
  subject: string;
  status: 'canceled' | 'pending' | 'approved' | 'rejected' | 'answered' | 'handed_back' | 'expired';
  conversation_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  title: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  expires_at: string | null;
  decided_at: string | null;
  created_at: string;
};

export type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  run_id: string | null;
  agent_id: string | null;
  read_at: string | null;
  created_at: string;
};

export type NotificationSettings = {
  channels: Array<'feishu' | 'email' | 'push' | 'wecom'>;
  categories: {
    needs_you: Partial<Record<'feishu' | 'email' | 'push' | 'wecom', boolean>>;
    replies: Partial<Record<'feishu' | 'email' | 'push' | 'wecom', boolean>>;
    runs: Partial<Record<'feishu' | 'email' | 'push' | 'wecom', boolean>>;
    other: Partial<Record<'feishu' | 'email' | 'push' | 'wecom', boolean>>;
  };
  previews: boolean;
};

export type UpdateNotificationSettingsInput = {
  categories?:
    | {
        needs_you?: Partial<Record<'feishu' | 'email' | 'push' | 'wecom', boolean>> | undefined;
        replies?: Partial<Record<'feishu' | 'email' | 'push' | 'wecom', boolean>> | undefined;
        runs?: Partial<Record<'feishu' | 'email' | 'push' | 'wecom', boolean>> | undefined;
        other?: Partial<Record<'feishu' | 'email' | 'push' | 'wecom', boolean>> | undefined;
      }
    | undefined;
  previews?: boolean | undefined;
};

export type PushPrefs = {
  needs_you: boolean;
  done: boolean;
  replies: boolean;
  preview: boolean;
  live_activity: boolean;
};

export type PushDevice = {
  id: string;
  platform: 'ios' | 'android';
  client_ref: string | null;
  prefs: { needs_you: boolean; done: boolean; replies: boolean; preview: boolean; live_activity: boolean };
  created_at: string;
  last_seen_at: string;
};

export type PushDeviceList = {
  devices: Array<{
    id: string;
    platform: 'ios' | 'android';
    client_ref: string | null;
    prefs: { needs_you: boolean; done: boolean; replies: boolean; preview: boolean; live_activity: boolean };
    created_at: string;
    last_seen_at: string;
  }>;
  enabled: boolean;
};

export type PushDeviceRegistered = {
  device: {
    id: string;
    platform: 'ios' | 'android';
    client_ref: string | null;
    prefs: { needs_you: boolean; done: boolean; replies: boolean; preview: boolean; live_activity: boolean };
    created_at: string;
    last_seen_at: string;
  } | null;
  enabled: boolean;
};

export type RegisterPushDeviceInput = {
  token: string;
  platform: 'ios' | 'android';
  project_id: string;
  client_ref?: string | null | undefined;
  prefs?:
    | {
        needs_you?: boolean | undefined;
        done?: boolean | undefined;
        replies?: boolean | undefined;
        preview?: boolean | undefined;
        live_activity?: boolean | undefined;
      }
    | undefined;
};

export type RunView = {
  id: string;
  agent_id: string;
  parent_run_id: string | null;
  summary: string | null;
  title: string;
  status: 'succeeded' | 'failed' | 'canceled' | 'queued' | 'running' | 'waiting';
  source: 'record' | 'app' | 'conversation' | 'schedule' | 'automation' | 'handoff';
  source_id: string | null;
  conversation_id: string | null;
  attempt: number;
  error: { code: string; message: string } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export type RunDetail = {
  id: string;
  agent_id: string;
  parent_run_id: string | null;
  summary: string | null;
  title: string;
  status: 'succeeded' | 'failed' | 'canceled' | 'queued' | 'running' | 'waiting';
  source: 'record' | 'app' | 'conversation' | 'schedule' | 'automation' | 'handoff';
  source_id: string | null;
  conversation_id: string | null;
  attempt: number;
  error: { code: string; message: string } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  progress: number | null;
  file_ids: Array<string>;
  findings: Array<string>;
  brief: string;
  output: string | null;
  steps: Array<{
    id: string;
    tool: string | null;
    kind: string;
    status: 'succeeded' | 'failed' | 'running' | 'pending' | 'skipped' | 'uncertain';
    attempt: number;
    input: unknown;
    output: unknown;
    error: { code: string; message: string } | null;
    duration_ms: number | null;
    request_id: string | null;
    started_at: string | null;
  }>;
  events: Array<{
    seq: number;
    type: string;
    payload: Record<string, unknown>;
    actor: string | null;
    created_at: string;
  }>;
};

export type FileView = {
  id: string;
  name: string;
  content_type: string;
  size_bytes: number;
  purpose:
    | 'record'
    | 'knowledge'
    | 'mail'
    | 'avatar'
    | 'skill'
    | 'attachment'
    | 'artifact'
    | 'export'
    | 'import'
    | 'branding'
    | 'tool_output';
  owner_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  url: string;
  expires_at: string;
  created_at: string;
};

export type ComputerView = {
  agent_id: string;
  state: 'failed' | 'stopped' | 'queued' | 'running' | 'starting';
  state_reason: string | null;
  last_active_at: string | null;
  last_started_at: string | null;
  queue_position?: number | null | undefined;
};

export type ComputerJob = {
  id: string;
  name: string;
  command: string;
  status: 'running' | 'exited' | 'lost';
  exit_code: number | null;
  started_at: string | null;
  ended_at: string | null;
};

export type ComputerTicket = { ticket: string; expires_at: string };

export type ComputerTicketPurpose = 'view' | 'control' | 'terminal';

export type ComputerFile = { name: string; type: 'file' | 'dir'; size: number; modified_at: string };

export type ComputerFolder = {
  path: string;
  items: Array<{ name: string; type: 'file' | 'dir'; size: number; modified_at: string }>;
  truncated: boolean;
};

export type SkillVariable = {
  label: string;
  type: 'text' | 'choice';
  required: boolean;
  key: string;
  options?: Array<string> | undefined;
};

export type Skill = {
  id: string;
  name: string;
  display_name: string;
  description: string;
  kind: 'package' | 'template';
  space: 'team' | 'personal';
  owner_id: string;
  tags: Array<string>;
  latest_version: string;
  requirements: { computer: boolean; connectors: Array<string> };
  variables: Array<{
    label: string;
    type: 'text' | 'choice';
    required: boolean;
    key: string;
    options?: Array<string> | undefined;
  }>;
  scan_status: 'pending' | 'clean' | 'suspicious' | 'blocked';
  scan_findings: Array<{ rule: string; severity: 'high' | 'medium'; excerpt: string; path?: string | undefined }>;
  scanned_at: string | null;
  scan_reviewed_by: string | null;
  scan_note: string | null;
  download_count: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  can_manage: boolean;
  can_review: boolean;
  available: boolean;
  unavailable: {
    code: 'archived' | 'blocked' | 'in_review' | 'needs_computer' | 'needs_connector';
    message: string;
    connector?: string | undefined;
  } | null;
};

export type SkillStarters = {
  skills: Array<{
    id: string;
    name: string;
    display_name: string;
    description: string;
    kind: 'package' | 'template';
    space: 'team' | 'personal';
    owner_id: string;
    tags: Array<string>;
    latest_version: string;
    requirements: { computer: boolean; connectors: Array<string> };
    variables: Array<{
      label: string;
      type: 'text' | 'choice';
      required: boolean;
      key: string;
      options?: Array<string> | undefined;
    }>;
    scan_status: 'pending' | 'clean' | 'suspicious' | 'blocked';
    scan_findings: Array<{ rule: string; severity: 'high' | 'medium'; excerpt: string; path?: string | undefined }>;
    scanned_at: string | null;
    scan_reviewed_by: string | null;
    scan_note: string | null;
    download_count: number;
    archived_at: string | null;
    created_at: string;
    updated_at: string;
    can_manage: boolean;
    can_review: boolean;
    available: boolean;
    unavailable: {
      code: 'archived' | 'blocked' | 'in_review' | 'needs_computer' | 'needs_connector';
      message: string;
      connector?: string | undefined;
    } | null;
  }>;
  starters: Array<string>;
};

export type Schedule = {
  id: string;
  agent_id: string;
  name: string;
  brief: string;
  quiet: boolean;
  computer: boolean;
  domains: Array<string>;
  continue_after: boolean;
  cron: string;
  timezone: string;
  status: 'active' | 'paused';
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  last_status: string | null;
  run_count: number;
  created_at: string;
};

export type CreateScheduleInput = {
  agent_id: string;
  name: string;
  brief: string;
  cron: string;
  quiet?: boolean | undefined;
  computer?: boolean | undefined;
  domains?: Array<string> | undefined;
  continue_after?: boolean | undefined;
  timezone?: string | undefined;
};

export type UpdateScheduleInput = {
  quiet?: boolean | undefined;
  computer?: boolean | undefined;
  domains?: Array<string> | undefined;
  continue_after?: boolean | undefined;
  name?: string | undefined;
  brief?: string | undefined;
  cron?: string | undefined;
  timezone?: string | undefined;
};

export type StandingApproval = {
  id: string;
  agent_id: string;
  scope_type: 'folder' | 'table';
  scope_id: string;
  actions: Array<string>;
  granted_at: string;
  revoked_at: string | null;
  scope_name?: string | null | undefined;
  scope_href?: string | null | undefined;
};

export type AppSummary = {
  id: string;
  base_id: string;
  name: string;
  description: string;
  owner_id: string;
  status: 'draft' | 'published';
  published_version: number | null;
  editable: boolean;
  pinned: boolean;
  featured: boolean;
};

export type AppRuntime = {
  app: AppSummary;
  version: number;
  pages: Array<{
    id: string;
    name: string;
    cards: Array<
      | {
          id: string;
          kind: 'number' | 'bar' | 'line' | 'pie' | 'list';
          title: string;
          table_id: string;
          filter?:
            | {
                mode: 'and' | 'or';
                clauses: Array<{
                  field: string;
                  op:
                    | 'eq'
                    | 'neq'
                    | 'contains'
                    | 'not_contains'
                    | 'gt'
                    | 'gte'
                    | 'lt'
                    | 'lte'
                    | 'is_empty'
                    | 'is_not_empty';
                  value?: string | number | boolean | Array<string | number> | null | undefined;
                }>;
              }
            | undefined;
          measure?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string | undefined } | undefined;
          group?:
            | {
                field: string;
                bucket?: 'month' | 'day' | 'week' | 'quarter' | 'year' | undefined;
                limit?: number | undefined;
              }
            | undefined;
          list?:
            | {
                fields: Array<string>;
                sorts?: Array<{ field: string; desc?: boolean | undefined }> | undefined;
                limit?: number | undefined;
              }
            | undefined;
          size?: 'medium' | 'small' | 'large' | undefined;
        }
      | {
          id: string;
          kind: 'records' | 'table' | 'kanban' | 'form';
          title: string;
          table_id: string;
          fields: Array<string>;
          actions: Array<{ id: string; name: string; type: 'create' | 'update'; values: Record<string, unknown> }>;
          detail_fields?: Array<string> | undefined;
          group_field?: string | undefined;
          filter?:
            | {
                mode: 'and' | 'or';
                clauses: Array<{
                  field: string;
                  op:
                    | 'eq'
                    | 'neq'
                    | 'contains'
                    | 'not_contains'
                    | 'gt'
                    | 'gte'
                    | 'lt'
                    | 'lte'
                    | 'is_empty'
                    | 'is_not_empty';
                  value?: string | number | boolean | Array<string | number> | null | undefined;
                }>;
              }
            | undefined;
        }
      | {
          id: string;
          kind: 'button';
          title: string;
          table_id: string;
          action: { id: string; name: string; type: 'create' | 'update'; values: Record<string, unknown> };
        }
      | {
          id: string;
          kind: 'custom';
          title: string;
          html: string;
          bindings?: Array<{ id: string; card: string }> | undefined;
          height?: number | undefined;
        }
      | {
          id: string;
          kind: 'external';
          title: string;
          source: { connector: string; tool: string; arguments: Record<string, unknown> };
          map:
            | { kind: 'number'; value: string }
            | { kind: 'table'; rows: string; columns: Array<{ label: string; path: string }> }
            | { kind: 'bar' | 'line'; rows: string; group: string; value: string };
        }
    >;
  }>;
  base: {
    name: string;
    id: string;
    updated_at: string;
    description: string;
    owner_id: string;
    template_key: string | null;
    archived_at: string | null;
    pinned: boolean;
    access: 'owner' | 'builder' | 'editor' | 'viewer';
    icon: string;
    custom_role: { id: string; name: string } | null;
    owner: { id: string; name: string };
    created_at: string;
    tables: Array<{
      id: string;
      base_id: string;
      name: string;
      description: string;
      position: number;
      schema_revision: number;
      fields: Array<{
        id: string;
        table_id: string;
        name: string;
        type:
          | 'number'
          | 'date'
          | 'email'
          | 'member'
          | 'text'
          | 'url'
          | 'attachment'
          | 'long_text'
          | 'checkbox'
          | 'datetime'
          | 'single_select'
          | 'multi_select'
          | 'phone'
          | 'relation'
          | 'parent'
          | 'dependency'
          | 'formula'
          | 'lookup'
          | 'rollup'
          | 'ai';
        config: {
          options?:
            | Array<{
                id: string;
                label: string;
                color: 'gray' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'purple';
              }>
            | undefined;
          precision?: number | undefined;
          multiple?: boolean | undefined;
          table_id?: string | undefined;
          formula_text?: string | undefined;
          formula?: unknown;
          result?: 'number' | 'date' | 'text' | 'checkbox' | 'datetime' | undefined;
          link_field?: string | undefined;
          target_field?: string | undefined;
          aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_values' | 'count_unique' | 'join' | undefined;
          prompt?: string | undefined;
          inputs?: Array<string> | undefined;
          auto_update?: boolean | undefined;
        };
        required: boolean;
        is_primary: boolean;
        position: number;
      }>;
      access?: 'edit' | 'read' | undefined;
    }>;
    views: Array<{
      id: string;
      table_id: string | null;
      name: string;
      type: 'kanban' | 'grid' | 'calendar' | 'gallery' | 'timeline' | 'dashboard';
      personal: boolean;
      config: {
        filter?:
          | {
              mode: 'and' | 'or';
              clauses: Array<{
                field: string;
                op:
                  | 'eq'
                  | 'neq'
                  | 'contains'
                  | 'not_contains'
                  | 'gt'
                  | 'gte'
                  | 'lt'
                  | 'lte'
                  | 'is_empty'
                  | 'is_not_empty';
                value?: string | number | boolean | Array<string | number> | null | undefined;
              }>;
            }
          | undefined;
        sorts?: Array<{ field: string; desc?: boolean | undefined }> | undefined;
        group?: { field: string; desc?: boolean | undefined } | null | undefined;
        order?: Array<string> | undefined;
        hidden?: Array<string> | undefined;
        widths?: Record<string, number> | undefined;
        frozen?: number | undefined;
        row_height?: 'medium' | 'short' | 'tall' | undefined;
        kanban?: { field: string; hide_empty?: boolean | undefined } | undefined;
        calendar?: { start: string; end?: string | undefined } | undefined;
        gallery?: { cover?: string | undefined } | undefined;
        timeline?:
          | {
              start: string;
              end?: string | undefined;
              dependency?: string | undefined;
              milestone?: { field: string; option?: string | undefined } | undefined;
              scale?: 'month' | 'day' | 'week' | undefined;
            }
          | undefined;
        cards?:
          | Array<{
              id: string;
              kind: 'number' | 'bar' | 'line' | 'pie' | 'list';
              title: string;
              table_id: string;
              filter?:
                | {
                    mode: 'and' | 'or';
                    clauses: Array<{
                      field: string;
                      op:
                        | 'eq'
                        | 'neq'
                        | 'contains'
                        | 'not_contains'
                        | 'gt'
                        | 'gte'
                        | 'lt'
                        | 'lte'
                        | 'is_empty'
                        | 'is_not_empty';
                      value?: string | number | boolean | Array<string | number> | null | undefined;
                    }>;
                  }
                | undefined;
              measure?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string | undefined } | undefined;
              group?:
                | {
                    field: string;
                    bucket?: 'month' | 'day' | 'week' | 'quarter' | 'year' | undefined;
                    limit?: number | undefined;
                  }
                | undefined;
              list?:
                | {
                    fields: Array<string>;
                    sorts?: Array<{ field: string; desc?: boolean | undefined }> | undefined;
                    limit?: number | undefined;
                  }
                | undefined;
              size?: 'medium' | 'small' | 'large' | undefined;
            }>
          | undefined;
      };
      position: number;
      revision: number;
      editable: boolean;
    }>;
    ai_fields: boolean;
  };
  preview: boolean;
  preview_role: string | null;
  custom_review: 'pending' | 'approved' | 'rejected';
};

export type AppCard =
  | {
      id: string;
      kind: 'number' | 'bar' | 'line' | 'pie' | 'list';
      title: string;
      table_id: string;
      filter?:
        | {
            mode: 'and' | 'or';
            clauses: Array<{
              field: string;
              op:
                | 'eq'
                | 'neq'
                | 'contains'
                | 'not_contains'
                | 'gt'
                | 'gte'
                | 'lt'
                | 'lte'
                | 'is_empty'
                | 'is_not_empty';
              value?: string | number | boolean | Array<string | number> | null | undefined;
            }>;
          }
        | undefined;
      measure?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string | undefined } | undefined;
      group?:
        | {
            field: string;
            bucket?: 'month' | 'day' | 'week' | 'quarter' | 'year' | undefined;
            limit?: number | undefined;
          }
        | undefined;
      list?:
        | {
            fields: Array<string>;
            sorts?: Array<{ field: string; desc?: boolean | undefined }> | undefined;
            limit?: number | undefined;
          }
        | undefined;
      size?: 'medium' | 'small' | 'large' | undefined;
    }
  | {
      id: string;
      kind: 'records' | 'table' | 'kanban' | 'form';
      title: string;
      table_id: string;
      fields: Array<string>;
      actions: Array<{ id: string; name: string; type: 'create' | 'update'; values: Record<string, unknown> }>;
      detail_fields?: Array<string> | undefined;
      group_field?: string | undefined;
      filter?:
        | {
            mode: 'and' | 'or';
            clauses: Array<{
              field: string;
              op:
                | 'eq'
                | 'neq'
                | 'contains'
                | 'not_contains'
                | 'gt'
                | 'gte'
                | 'lt'
                | 'lte'
                | 'is_empty'
                | 'is_not_empty';
              value?: string | number | boolean | Array<string | number> | null | undefined;
            }>;
          }
        | undefined;
    }
  | {
      id: string;
      kind: 'button';
      title: string;
      table_id: string;
      action: { id: string; name: string; type: 'create' | 'update'; values: Record<string, unknown> };
    }
  | {
      id: string;
      kind: 'custom';
      title: string;
      html: string;
      bindings?: Array<{ id: string; card: string }> | undefined;
      height?: number | undefined;
    }
  | {
      id: string;
      kind: 'external';
      title: string;
      source: { connector: string; tool: string; arguments: Record<string, unknown> };
      map:
        | { kind: 'number'; value: string }
        | { kind: 'table'; rows: string; columns: Array<{ label: string; path: string }> }
        | { kind: 'bar' | 'line'; rows: string; group: string; value: string };
    };

export type AppAction = { id: string; name: string; type: 'create' | 'update'; values: Record<string, unknown> };

export type AppCardAnswer =
  | {
      kind: 'chart';
      data:
        | { kind: 'number'; value: number | null; records: number }
        | {
            kind: 'groups';
            key_type: 'number' | 'date' | 'member' | 'text' | 'checkbox' | 'option';
            groups: Array<{
              key: string | null;
              label: string;
              value: number | null;
              records: number;
              color?: 'gray' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'purple' | undefined;
            }>;
            other: { value: number | null; records: number } | null;
            records: number;
            bucket?: 'month' | 'day' | 'week' | 'quarter' | 'year' | undefined;
          }
        | {
            kind: 'list';
            title_field: string | null;
            fields: Array<string>;
            items: Array<{
              id: string;
              table_id: string;
              values: Record<string, unknown>;
              revision: number;
              computed_revision: number;
              created_by: string | null;
              created_at: string;
              updated_by: string | null;
              updated_at: string;
            }>;
            linked: Record<string, { title: string; table_id: string }>;
            files: Record<string, { id: string; name: string; content_type: string; size_bytes: number; url: string }>;
            records: number;
          }
        | { kind: 'error'; code: 'failed' | 'table_hidden' | 'field_hidden' | 'incomplete' };
    }
  | {
      kind: 'records';
      data: {
        items: Array<{
          id: string;
          table_id: string;
          values: Record<string, unknown>;
          revision: number;
          computed_revision: number;
          created_by: string | null;
          created_at: string;
          updated_by: string | null;
          updated_at: string;
        }>;
        next_cursor: string | null;
        linked: Record<string, { title: string; table_id: string }>;
        files: Record<string, { id: string; name: string; content_type: string; size_bytes: number; url: string }>;
        total?: number | undefined;
      };
    }
  | { kind: 'external'; columns: Array<string>; rows: Array<Array<string | number | boolean | null>> }
  | { kind: 'empty' };

export type CardData =
  | { kind: 'number'; value: number | null; records: number }
  | {
      kind: 'groups';
      key_type: 'number' | 'date' | 'member' | 'text' | 'checkbox' | 'option';
      groups: Array<{
        key: string | null;
        label: string;
        value: number | null;
        records: number;
        color?: 'gray' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'purple' | undefined;
      }>;
      other: { value: number | null; records: number } | null;
      records: number;
      bucket?: 'month' | 'day' | 'week' | 'quarter' | 'year' | undefined;
    }
  | {
      kind: 'list';
      title_field: string | null;
      fields: Array<string>;
      items: Array<{
        id: string;
        table_id: string;
        values: Record<string, unknown>;
        revision: number;
        computed_revision: number;
        created_by: string | null;
        created_at: string;
        updated_by: string | null;
        updated_at: string;
      }>;
      linked: Record<string, { title: string; table_id: string }>;
      files: Record<string, { id: string; name: string; content_type: string; size_bytes: number; url: string }>;
      records: number;
    }
  | { kind: 'error'; code: 'failed' | 'table_hidden' | 'field_hidden' | 'incomplete' };

export type KnowledgeScope = 'team' | 'personal' | 'shared';

export type KnowledgeItem = {
  type: 'file' | 'doc' | 'folder';
  id: string;
  name: string;
  space: 'team' | 'personal';
  folder_id: string | null;
  owner_id: string | null;
  sort_order: number;
  access: 'owner' | 'editor' | 'viewer';
  shared: boolean;
  agent_id: string | null;
  is_template: boolean;
  content_type: string | null;
  size_bytes: number | null;
  archived_at: string | null;
  updated_at: string;
};

export type KnowledgeFolder = {
  type: 'file' | 'doc' | 'folder';
  id: string;
  name: string;
  space: 'team' | 'personal';
  folder_id: string | null;
  owner_id: string | null;
  sort_order: number;
  access: 'owner' | 'editor' | 'viewer';
  shared: boolean;
  agent_id: string | null;
  is_template: boolean;
  content_type: string | null;
  size_bytes: number | null;
  archived_at: string | null;
  updated_at: string;
  path: Array<{ id: string; name: string }>;
  children: Array<{
    type: 'file' | 'doc' | 'folder';
    id: string;
    name: string;
    space: 'team' | 'personal';
    folder_id: string | null;
    owner_id: string | null;
    sort_order: number;
    access: 'owner' | 'editor' | 'viewer';
    shared: boolean;
    agent_id: string | null;
    is_template: boolean;
    content_type: string | null;
    size_bytes: number | null;
    archived_at: string | null;
    updated_at: string;
  }>;
  next_cursor: string | null;
  created_by: { id: string; name: string } | null;
  created_at: string;
};

export type KnowledgeDoc = {
  id: string;
  title: string;
  content: string;
  space: 'team' | 'personal';
  folder_id: string | null;
  owner_id: string | null;
  path: Array<{ id: string; name: string }>;
  is_template: boolean;
  tags: Array<string>;
  meta: { summary?: string | undefined; questions?: Array<string> | undefined; topics?: Array<string> | undefined };
  version: number;
  sort_order: number;
  access: 'owner' | 'editor' | 'viewer';
  shared: boolean;
  agent_id: string | null;
  created_by: { id: string; name: string } | null;
  updated_by: { id: string; name: string } | null;
  updated_by_agent: { id: string; name: string } | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type KnowledgeFile = {
  type: 'file' | 'doc' | 'folder';
  id: string;
  name: string;
  space: 'team' | 'personal';
  folder_id: string | null;
  owner_id: string | null;
  sort_order: number;
  access: 'owner' | 'editor' | 'viewer';
  shared: boolean;
  agent_id: string | null;
  is_template: boolean;
  content_type: string | null;
  size_bytes: number | null;
  archived_at: string | null;
  updated_at: string;
  doc_id: string | null;
  preview: 'image' | 'video' | 'text' | 'none' | 'pdf' | 'audio';
  url: string;
  expires_at: string;
  created_at: string;
};

export type KnowledgeSearchHit = {
  type: 'file' | 'doc';
  id: string;
  title: string;
  snippet: string;
  space: 'team' | 'personal';
  folder_id: string | null;
  path: Array<{ id: string; name: string }>;
  score: number;
  updated_at: string;
};

export type KnowledgeComment = {
  id: string;
  target_type: 'record' | 'doc';
  target_id: string;
  body: string;
  mentions: Array<string>;
  created_by: { id: string; name: string } | null;
  agent: { id: string; name: string } | null;
  mine: boolean;
  edited: boolean;
  created_at: string;
  updated_at: string;
};

export type KnowledgeShares = {
  items: Array<{ type: 'member' | 'workspace' | 'group'; id: string | null; name: string; role: 'editor' | 'viewer' }>;
  inherited: Array<{
    type: 'member' | 'workspace' | 'group';
    id: string | null;
    name: string;
    role: 'editor' | 'viewer';
    folder_id: string;
    folder_name: string;
  }>;
};

export type DocVersion = {
  version: number;
  title: string;
  change_note: string;
  created_by: { id: string; name: string } | null;
  agent: { id: string; name: string } | null;
  created_at: string;
};

export type DocVersionDetail = {
  version: number;
  title: string;
  change_note: string;
  created_by: { id: string; name: string } | null;
  agent: { id: string; name: string } | null;
  created_at: string;
  content: string;
};

export type DocPresence = { member_id: string; name: string; state: 'viewing' | 'editing'; since: string };

export type View = {
  id: string;
  table_id: string | null;
  name: string;
  type: 'kanban' | 'grid' | 'calendar' | 'gallery' | 'timeline' | 'dashboard';
  personal: boolean;
  config: {
    filter?:
      | {
          mode: 'and' | 'or';
          clauses: Array<{
            field: string;
            op: 'eq' | 'neq' | 'contains' | 'not_contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'is_empty' | 'is_not_empty';
            value?: string | number | boolean | Array<string | number> | null | undefined;
          }>;
        }
      | undefined;
    sorts?: Array<{ field: string; desc?: boolean | undefined }> | undefined;
    group?: { field: string; desc?: boolean | undefined } | null | undefined;
    order?: Array<string> | undefined;
    hidden?: Array<string> | undefined;
    widths?: Record<string, number> | undefined;
    frozen?: number | undefined;
    row_height?: 'medium' | 'short' | 'tall' | undefined;
    kanban?: { field: string; hide_empty?: boolean | undefined } | undefined;
    calendar?: { start: string; end?: string | undefined } | undefined;
    gallery?: { cover?: string | undefined } | undefined;
    timeline?:
      | {
          start: string;
          end?: string | undefined;
          dependency?: string | undefined;
          milestone?: { field: string; option?: string | undefined } | undefined;
          scale?: 'month' | 'day' | 'week' | undefined;
        }
      | undefined;
    cards?:
      | Array<{
          id: string;
          kind: 'number' | 'bar' | 'line' | 'pie' | 'list';
          title: string;
          table_id: string;
          filter?:
            | {
                mode: 'and' | 'or';
                clauses: Array<{
                  field: string;
                  op:
                    | 'eq'
                    | 'neq'
                    | 'contains'
                    | 'not_contains'
                    | 'gt'
                    | 'gte'
                    | 'lt'
                    | 'lte'
                    | 'is_empty'
                    | 'is_not_empty';
                  value?: string | number | boolean | Array<string | number> | null | undefined;
                }>;
              }
            | undefined;
          measure?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string | undefined } | undefined;
          group?:
            | {
                field: string;
                bucket?: 'month' | 'day' | 'week' | 'quarter' | 'year' | undefined;
                limit?: number | undefined;
              }
            | undefined;
          list?:
            | {
                fields: Array<string>;
                sorts?: Array<{ field: string; desc?: boolean | undefined }> | undefined;
                limit?: number | undefined;
              }
            | undefined;
          size?: 'medium' | 'small' | 'large' | undefined;
        }>
      | undefined;
  };
  position: number;
  revision: number;
  editable: boolean;
};

export type Base = {
  name: string;
  id: string;
  updated_at: string;
  description: string;
  owner_id: string;
  template_key: string | null;
  archived_at: string | null;
  pinned: boolean;
  access: 'owner' | 'builder' | 'editor' | 'viewer';
  icon: string;
  custom_role: { id: string; name: string } | null;
  owner: { id: string; name: string };
  created_at: string;
  tables: Array<{
    id: string;
    base_id: string;
    name: string;
    description: string;
    position: number;
    schema_revision: number;
    fields: Array<{
      id: string;
      table_id: string;
      name: string;
      type:
        | 'number'
        | 'date'
        | 'email'
        | 'member'
        | 'text'
        | 'url'
        | 'attachment'
        | 'long_text'
        | 'checkbox'
        | 'datetime'
        | 'single_select'
        | 'multi_select'
        | 'phone'
        | 'relation'
        | 'parent'
        | 'dependency'
        | 'formula'
        | 'lookup'
        | 'rollup'
        | 'ai';
      config: {
        options?:
          | Array<{
              id: string;
              label: string;
              color: 'gray' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'purple';
            }>
          | undefined;
        precision?: number | undefined;
        multiple?: boolean | undefined;
        table_id?: string | undefined;
        formula_text?: string | undefined;
        formula?: unknown;
        result?: 'number' | 'date' | 'text' | 'checkbox' | 'datetime' | undefined;
        link_field?: string | undefined;
        target_field?: string | undefined;
        aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_values' | 'count_unique' | 'join' | undefined;
        prompt?: string | undefined;
        inputs?: Array<string> | undefined;
        auto_update?: boolean | undefined;
      };
      required: boolean;
      is_primary: boolean;
      position: number;
    }>;
    access?: 'edit' | 'read' | undefined;
  }>;
  views: Array<{
    id: string;
    table_id: string | null;
    name: string;
    type: 'kanban' | 'grid' | 'calendar' | 'gallery' | 'timeline' | 'dashboard';
    personal: boolean;
    config: {
      filter?:
        | {
            mode: 'and' | 'or';
            clauses: Array<{
              field: string;
              op:
                | 'eq'
                | 'neq'
                | 'contains'
                | 'not_contains'
                | 'gt'
                | 'gte'
                | 'lt'
                | 'lte'
                | 'is_empty'
                | 'is_not_empty';
              value?: string | number | boolean | Array<string | number> | null | undefined;
            }>;
          }
        | undefined;
      sorts?: Array<{ field: string; desc?: boolean | undefined }> | undefined;
      group?: { field: string; desc?: boolean | undefined } | null | undefined;
      order?: Array<string> | undefined;
      hidden?: Array<string> | undefined;
      widths?: Record<string, number> | undefined;
      frozen?: number | undefined;
      row_height?: 'medium' | 'short' | 'tall' | undefined;
      kanban?: { field: string; hide_empty?: boolean | undefined } | undefined;
      calendar?: { start: string; end?: string | undefined } | undefined;
      gallery?: { cover?: string | undefined } | undefined;
      timeline?:
        | {
            start: string;
            end?: string | undefined;
            dependency?: string | undefined;
            milestone?: { field: string; option?: string | undefined } | undefined;
            scale?: 'month' | 'day' | 'week' | undefined;
          }
        | undefined;
      cards?:
        | Array<{
            id: string;
            kind: 'number' | 'bar' | 'line' | 'pie' | 'list';
            title: string;
            table_id: string;
            filter?:
              | {
                  mode: 'and' | 'or';
                  clauses: Array<{
                    field: string;
                    op:
                      | 'eq'
                      | 'neq'
                      | 'contains'
                      | 'not_contains'
                      | 'gt'
                      | 'gte'
                      | 'lt'
                      | 'lte'
                      | 'is_empty'
                      | 'is_not_empty';
                    value?: string | number | boolean | Array<string | number> | null | undefined;
                  }>;
                }
              | undefined;
            measure?: { aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string | undefined } | undefined;
            group?:
              | {
                  field: string;
                  bucket?: 'month' | 'day' | 'week' | 'quarter' | 'year' | undefined;
                  limit?: number | undefined;
                }
              | undefined;
            list?:
              | {
                  fields: Array<string>;
                  sorts?: Array<{ field: string; desc?: boolean | undefined }> | undefined;
                  limit?: number | undefined;
                }
              | undefined;
            size?: 'medium' | 'small' | 'large' | undefined;
          }>
        | undefined;
    };
    position: number;
    revision: number;
    editable: boolean;
  }>;
  ai_fields: boolean;
};

export type BaseSummary = {
  id: string;
  name: string;
  description: string;
  icon: string;
  owner_id: string;
  access: 'owner' | 'builder' | 'editor' | 'viewer';
  pinned: boolean;
  template_key: string | null;
  archived_at: string | null;
  updated_at: string;
  tables: Array<{
    id: string;
    name: string;
    views: Array<{
      id: string;
      name: string;
      type: 'kanban' | 'grid' | 'calendar' | 'gallery' | 'timeline' | 'dashboard';
      personal: boolean;
    }>;
  }>;
  dashboards: Array<{ id: string; name: string; personal: boolean }>;
  custom_role: { id: string; name: string } | null;
};

export type BaseTable = {
  id: string;
  base_id: string;
  name: string;
  description: string;
  position: number;
  schema_revision: number;
  fields: Array<{
    id: string;
    table_id: string;
    name: string;
    type:
      | 'number'
      | 'date'
      | 'email'
      | 'member'
      | 'text'
      | 'url'
      | 'attachment'
      | 'long_text'
      | 'checkbox'
      | 'datetime'
      | 'single_select'
      | 'multi_select'
      | 'phone'
      | 'relation'
      | 'parent'
      | 'dependency'
      | 'formula'
      | 'lookup'
      | 'rollup'
      | 'ai';
    config: {
      options?:
        | Array<{
            id: string;
            label: string;
            color: 'gray' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'purple';
          }>
        | undefined;
      precision?: number | undefined;
      multiple?: boolean | undefined;
      table_id?: string | undefined;
      formula_text?: string | undefined;
      formula?: unknown;
      result?: 'number' | 'date' | 'text' | 'checkbox' | 'datetime' | undefined;
      link_field?: string | undefined;
      target_field?: string | undefined;
      aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_values' | 'count_unique' | 'join' | undefined;
      prompt?: string | undefined;
      inputs?: Array<string> | undefined;
      auto_update?: boolean | undefined;
    };
    required: boolean;
    is_primary: boolean;
    position: number;
  }>;
  access?: 'edit' | 'read' | undefined;
};

export type Field = {
  id: string;
  table_id: string;
  name: string;
  type:
    | 'number'
    | 'date'
    | 'email'
    | 'member'
    | 'text'
    | 'url'
    | 'attachment'
    | 'long_text'
    | 'checkbox'
    | 'datetime'
    | 'single_select'
    | 'multi_select'
    | 'phone'
    | 'relation'
    | 'parent'
    | 'dependency'
    | 'formula'
    | 'lookup'
    | 'rollup'
    | 'ai';
  config: {
    options?:
      | Array<{
          id: string;
          label: string;
          color: 'gray' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'purple';
        }>
      | undefined;
    precision?: number | undefined;
    multiple?: boolean | undefined;
    table_id?: string | undefined;
    formula_text?: string | undefined;
    formula?: unknown;
    result?: 'number' | 'date' | 'text' | 'checkbox' | 'datetime' | undefined;
    link_field?: string | undefined;
    target_field?: string | undefined;
    aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_values' | 'count_unique' | 'join' | undefined;
    prompt?: string | undefined;
    inputs?: Array<string> | undefined;
    auto_update?: boolean | undefined;
  };
  required: boolean;
  is_primary: boolean;
  position: number;
};

export type TableRecord = {
  id: string;
  table_id: string;
  values: Record<string, unknown>;
  revision: number;
  computed_revision: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
};

export type RecordPage = {
  items: Array<{
    id: string;
    table_id: string;
    values: Record<string, unknown>;
    revision: number;
    computed_revision: number;
    created_by: string | null;
    created_at: string;
    updated_by: string | null;
    updated_at: string;
  }>;
  next_cursor: string | null;
  linked: Record<string, { title: string; table_id: string }>;
  files: Record<string, { id: string; name: string; content_type: string; size_bytes: number; url: string }>;
  total?: number | undefined;
};

export type RecordDetail = {
  record: {
    id: string;
    table_id: string;
    values: Record<string, unknown>;
    revision: number;
    computed_revision: number;
    created_by: string | null;
    created_at: string;
    updated_by: string | null;
    updated_at: string;
  };
  base_id: string;
  table_id: string;
  linked: Record<string, { title: string; table_id: string }>;
  files: Record<string, { id: string; name: string; content_type: string; size_bytes: number; url: string }>;
  children: Array<{ id: string; title: string }>;
};

export type RecordActivity = {
  items: Array<
    | {
        kind: 'event';
        id: string;
        type: 'created' | 'updated' | 'deleted' | 'restored';
        actor: { type: string; id: string | null; name: string };
        changes: Array<{ field: string; name: string; before: unknown; after: unknown }>;
        created_at: string;
      }
    | {
        id: string;
        target_type: 'record' | 'doc';
        target_id: string;
        body: string;
        mentions: Array<string>;
        created_by: { id: string; name: string } | null;
        agent: { id: string; name: string } | null;
        mine: boolean;
        edited: boolean;
        created_at: string;
        updated_at: string;
        kind: 'comment';
      }
  >;
  next_cursor: string | null;
  linked: Record<string, { title: string; table_id: string }>;
};

export type Form = {
  id: string;
  base_id: string;
  table_id: string;
  name: string;
  description: string;
  status: 'draft' | 'published';
  config: {
    fields: Array<{
      field_id: string;
      label?: string | undefined;
      help?: string | undefined;
      required?: boolean | undefined;
    }>;
    submit_label?: string | undefined;
    success_message?: string | undefined;
    single_submit?: boolean | undefined;
  };
  revision: number;
  submission_count: number;
  created_at: string;
  updated_at: string;
};

export type FormFill = {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'published';
  fields: Array<{
    id: string;
    table_id: string;
    name: string;
    help: string;
    type:
      | 'number'
      | 'date'
      | 'email'
      | 'member'
      | 'text'
      | 'url'
      | 'attachment'
      | 'long_text'
      | 'checkbox'
      | 'datetime'
      | 'single_select'
      | 'multi_select'
      | 'phone'
      | 'relation'
      | 'parent'
      | 'dependency'
      | 'formula'
      | 'lookup'
      | 'rollup'
      | 'ai';
    required: boolean;
    config: {
      options?:
        | Array<{
            id: string;
            label: string;
            color: 'gray' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'purple';
          }>
        | undefined;
      precision?: number | undefined;
      multiple?: boolean | undefined;
      table_id?: string | undefined;
      formula_text?: string | undefined;
      formula?: unknown;
      result?: 'number' | 'date' | 'text' | 'checkbox' | 'datetime' | undefined;
      link_field?: string | undefined;
      target_field?: string | undefined;
      aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_values' | 'count_unique' | 'join' | undefined;
      prompt?: string | undefined;
      inputs?: Array<string> | undefined;
      auto_update?: boolean | undefined;
    };
  }>;
  submit_label: string;
  success_message: string;
  single_submit: boolean;
  submitted: boolean;
};

export type FormFillField = {
  id: string;
  table_id: string;
  name: string;
  help: string;
  type:
    | 'number'
    | 'date'
    | 'email'
    | 'member'
    | 'text'
    | 'url'
    | 'attachment'
    | 'long_text'
    | 'checkbox'
    | 'datetime'
    | 'single_select'
    | 'multi_select'
    | 'phone'
    | 'relation'
    | 'parent'
    | 'dependency'
    | 'formula'
    | 'lookup'
    | 'rollup'
    | 'ai';
  required: boolean;
  config: {
    options?:
      | Array<{
          id: string;
          label: string;
          color: 'gray' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'pink' | 'purple';
        }>
      | undefined;
    precision?: number | undefined;
    multiple?: boolean | undefined;
    table_id?: string | undefined;
    formula_text?: string | undefined;
    formula?: unknown;
    result?: 'number' | 'date' | 'text' | 'checkbox' | 'datetime' | undefined;
    link_field?: string | undefined;
    target_field?: string | undefined;
    aggregate?: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'count_values' | 'count_unique' | 'join' | undefined;
    prompt?: string | undefined;
    inputs?: Array<string> | undefined;
    auto_update?: boolean | undefined;
  };
};

export type Mailbox =
  | { available: false; reason: 'archived' | 'not_configured' | 'public_agent' }
  | {
      available: true;
      address: string;
      local_part: string;
      domain: string;
      allow_members: boolean;
      senders: Array<{ address: string; created_at: string }>;
      screened_count: number;
    };

export type MailItem = {
  id: string;
  agent_id: string;
  direction: 'out' | 'in';
  status: 'failed' | 'screened' | 'delivered' | 'sending' | 'sent';
  screen_reason: 'archived' | 'public_agent' | 'sender' | 'unverified' | null;
  from: { address: string; name: string | null };
  to: Array<{ address: string; name: string | null }>;
  cc: Array<{ address: string; name: string | null }>;
  subject: string;
  preview: string;
  attachment_count: number;
  verified: boolean;
  conversation_id: string | null;
  at: string;
};

export type MailDetail = {
  id: string;
  agent_id: string;
  direction: 'out' | 'in';
  status: 'failed' | 'screened' | 'delivered' | 'sending' | 'sent';
  screen_reason: 'archived' | 'public_agent' | 'sender' | 'unverified' | null;
  from: { address: string; name: string | null };
  to: Array<{ address: string; name: string | null }>;
  cc: Array<{ address: string; name: string | null }>;
  subject: string;
  preview: string;
  attachment_count: number;
  verified: boolean;
  conversation_id: string | null;
  at: string;
  reply_to: Array<{ address: string; name: string | null }>;
  text: string;
  html: string | null;
  attachments: Array<{
    name: string;
    content_type: string;
    size_bytes: number;
    content_id: string | null;
    inline: boolean;
    url: string | null;
    skipped: 'unavailable' | 'too_large' | 'too_many' | null;
  }>;
  message_id: string | null;
  in_reply_to: string | null;
  auth: { spf: string; dkim: string; dmarc: string };
  error: string | null;
};

export const API_VERSION = 2 as const;

export const REALTIME_SIGN_IN_AGAIN = 4401 as const;

export const COMPUTER_SOCKET_CLOSE = { ticket: 4401, forbidden: 4403, stopped: 4409 } as const;

export const CONVERSATION_KINDS = ['main', 'direct', 'chat', 'room'] as const;

export const MESSAGE_MAX = 32000 as const;

export const FEEDBACK_COMMENT_MAX = 500 as const;

export const AGENT_NAME_MAX = 24 as const;

export const AGENT_ROLE_MAX = 40 as const;

export const AGENT_DESCRIPTION_MAX = 500 as const;

export const AGENT_INSTRUCTIONS_MAX = 8000 as const;

export const MAX_AGENTS = 20 as const;

export const MAX_VIEW_RECORDS = 5000 as const;

export const COMPUTED_FIELD_TYPES = ['formula', 'lookup', 'rollup', 'ai'] as const;

export const THEMES = ['system', 'light', 'dark'] as const;

export const REQUEST_KINDS = ['approval', 'login', 'takeover', 'question', 'proposal'] as const;

export const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled'] as const;

export const RUN_SOURCES = ['conversation', 'schedule', 'automation', 'record', 'handoff', 'app'] as const;

export const COMPUTER_STATES = ['stopped', 'queued', 'starting', 'running', 'failed'] as const;

export const NOTIFICATION_CATEGORIES = ['needs_you', 'replies', 'runs', 'other'] as const;

export const DELIVERY_CHANNELS = ['email', 'feishu', 'wecom', 'push'] as const;

export const PUSH_PLATFORMS = ['ios', 'android'] as const;

export const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;
