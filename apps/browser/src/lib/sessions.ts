/**
 * Session API — the extension keeps its history server-side on the dedicated
 * 'browser' channel, so the web app can list/continue these sessions too.
 */

import type { ToolCall } from '@greenhouse/ui/components/tool-call';
import { authFetch } from './auth';

export interface BrowserSession {
  id: string;
  title: string | null;
  profile_id: string;
  updated_at: string;
}

export interface HistoryMessage {
  role: string;
  content: string;
  reasoning?: string | null;
  toolCalls: ToolCall[];
}

export async function createSession(profileId: string): Promise<BrowserSession> {
  const res = await authFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_id: profileId, channel: 'browser' }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `http_${res.status}`);
  }
  return (await res.json()) as BrowserSession;
}

export async function listSessions(): Promise<BrowserSession[]> {
  const res = await authFetch('/api/sessions?channel=browser&limit=30');
  if (!res.ok) return [];
  const body = (await res.json()) as { sessions?: BrowserSession[] };
  return body.sessions ?? [];
}

/** Load a session's messages, mapping stored pipeline steps back to tool-call cards. */
export async function getSessionMessages(sessionId: string): Promise<HistoryMessage[]> {
  const res = await authFetch(`/api/sessions/${sessionId}`);
  if (!res.ok) return [];
  const body = (await res.json()) as {
    messages?: Array<{ role: string; content: string; reasoning?: string | null; pipeline?: string | null }>;
  };
  return (body.messages ?? []).map((m) => {
    let toolCalls: ToolCall[] = [];
    if (m.pipeline) {
      try {
        const steps = JSON.parse(m.pipeline) as Array<{
          tool: string;
          input: unknown;
          output: unknown;
          duration_ms?: number;
          step?: number;
        }>;
        toolCalls = steps.map((s) => ({
          name: s.tool,
          input: s.input,
          output: s.output,
          status: 'done' as const,
          durationMs: s.duration_ms,
          step: s.step,
        }));
      } catch {
        // Malformed pipeline JSON — render the message without tool cards.
      }
    }
    return { role: m.role, content: m.content, reasoning: m.reasoning, toolCalls };
  });
}

export interface ProfileOption {
  id: string;
  name: string;
  description?: string;
}

export async function fetchProfiles(): Promise<ProfileOption[]> {
  const res = await authFetch('/api/profiles');
  if (!res.ok) return [];
  const body = (await res.json()) as { profiles?: ProfileOption[] };
  return body.profiles ?? [];
}
