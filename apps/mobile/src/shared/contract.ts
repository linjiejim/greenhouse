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
  steps: Array<{ tool: string; summary: string; status: 'done' | 'failed'; duration_ms?: number | undefined }>;
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
  steps: Array<{ tool: string; summary: string; status: 'done' | 'failed'; duration_ms?: number | undefined }>;
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
    steps: Array<{ tool: string; summary: string; status: 'done' | 'failed'; duration_ms?: number | undefined }>;
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
    steps: Array<{ tool: string; summary: string; status: 'done' | 'failed'; duration_ms?: number | undefined }>;
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
          steps: Array<{ tool: string; summary: string; status: 'done' | 'failed'; duration_ms?: number | undefined }>;
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
          status: 'done' | 'failed' | 'running';
          duration_ms?: number | undefined;
        };
      };
    }
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
          steps: Array<{ tool: string; summary: string; status: 'done' | 'failed'; duration_ms?: number | undefined }>;
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
  | { type: 'computer.updated'; data: { agent_id: string; state: 'failed' | 'stopped' | 'running' | 'starting' } }
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
  status: 'pending' | 'approved' | 'rejected' | 'answered' | 'handed_back' | 'expired' | 'canceled';
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
  title: string;
  status: 'failed' | 'queued' | 'running' | 'canceled' | 'waiting' | 'succeeded';
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
  title: string;
  status: 'failed' | 'queued' | 'running' | 'canceled' | 'waiting' | 'succeeded';
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
    status: 'failed' | 'running' | 'pending' | 'succeeded' | 'skipped' | 'uncertain';
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
    | 'branding';
  owner_id: string | null;
  conversation_id: string | null;
  run_id: string | null;
  url: string;
  expires_at: string;
  created_at: string;
};

export type ComputerView = {
  agent_id: string;
  state: 'failed' | 'stopped' | 'running' | 'starting';
  state_reason: string | null;
  last_active_at: string | null;
  last_started_at: string | null;
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

export const THEMES = ['system', 'light', 'dark'] as const;

export const REQUEST_KINDS = ['approval', 'login', 'takeover', 'question', 'proposal'] as const;

export const RUN_STATUSES = ['queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled'] as const;

export const RUN_SOURCES = ['conversation', 'schedule', 'automation', 'record', 'handoff', 'app'] as const;

export const COMPUTER_STATES = ['stopped', 'starting', 'running', 'failed'] as const;

export const NOTIFICATION_CATEGORIES = ['needs_you', 'replies', 'runs', 'other'] as const;

export const DELIVERY_CHANNELS = ['email', 'feishu', 'wecom', 'push'] as const;

export const PUSH_PLATFORMS = ['ios', 'android'] as const;

export const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{1,200}\]$/;
