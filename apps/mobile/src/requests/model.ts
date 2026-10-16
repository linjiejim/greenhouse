/**
 * 「需要你」 cards, React-free (./model.test.ts): what a card shows and what it can do.
 *
 * One model for the five kinds (CONV-17): approval (a write the Agent wants to make — what and
 * where), login (a site and the vault item to fill), takeover (why the member is needed at the
 * computer), question (a form), proposal (new instructions, a background run, a skill to save).
 * A card is decided once: pending until approved, rejected, answered, handed back, expired or
 * canceled. Status words and tones follow docs/design-system/content.md: yellow only while it
 * needs you.
 */

import type { NeedsYou, QuestionField } from '../shared/contract';
import { parseMs } from '../data/time';

export type RequestTone = 'warning' | 'success' | 'neutral';

/** The status word's key (in `requests.*`) and its tone. */
export function requestStatus(request: Pick<NeedsYou, 'status'>): { word: string; tone: RequestTone } {
  switch (request.status) {
    case 'pending':
      return { word: 'needsYou', tone: 'warning' };
    case 'approved':
      return { word: 'approved', tone: 'success' };
    case 'answered':
      return { word: 'done', tone: 'success' };
    case 'handed_back':
      return { word: 'handedBack', tone: 'success' };
    case 'rejected':
      return { word: 'rejected', tone: 'neutral' };
    case 'expired':
      return { word: 'expired', tone: 'neutral' };
    case 'superseded':
      return { word: 'superseded', tone: 'neutral' };
    case 'withdrawn':
      return { word: 'withdrawn', tone: 'neutral' };
    case 'canceled':
      return { word: 'canceled', tone: 'neutral' };
  }
}

/** The icon of a kind (names in src/ui/core.tsx ICONS). */
export const KIND_ICON = {
  approval: 'shieldCheck',
  login: 'key',
  takeover: 'computer',
  question: 'form',
  proposal: 'sparkle',
} as const satisfies Record<NeedsYou['kind'], string>;

/** The decisions a pending card offers on a phone. */
export type CardAction = 'approve' | 'reject' | 'answer' | 'takeOver' | 'handBack' | 'signInMyself';

/** Which buttons a card has, primary last; none once it is decided. */
export function cardActions(
  request: Pick<NeedsYou, 'kind' | 'subject' | 'status' | 'agent_id'>,
  computers: boolean,
): CardAction[] {
  if (request.status !== 'pending') return [];
  switch (request.kind) {
    case 'question':
      return ['reject', 'answer'];
    case 'approval':
    case 'proposal':
      return ['reject', 'approve'];
    case 'login':
      return [
        'reject',
        ...(request.agent_id && computers ? (['signInMyself'] as const) : []),
        ...(request.subject === 'vault_fill' ? (['approve'] as const) : (['handBack'] as const)),
      ];
    case 'takeover':
      return request.agent_id && computers ? ['handBack', 'takeOver'] : ['handBack'];
  }
}

/** A field of the card: a label and its value, in reading order. */
export interface CardDetail {
  label: string;
  value: string;
  format?: 'markdown' | 'chips';
}

const text = (value: unknown) => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value));

/** What a card says beyond its title: details, a body of text, and its form (a question). */
export function cardBody(request: Pick<NeedsYou, 'kind' | 'subject' | 'payload'>): {
  /** A sentence about why (a take-over's reason, a proposal's reason). */
  reason: string;
  details: CardDetail[];
  /** A longer text: new instructions, a run's brief, a skill's body. */
  body: string;
  /** The heading over `body`. */
  bodyLabel: 'instructions' | 'brief' | 'skill' | null;
  fields: QuestionField[];
} {
  const payload = request.payload ?? {};
  const reason = text(payload.summary) || text(payload.reason);
  if (request.kind === 'question') {
    return {
      reason: '',
      details: [],
      body: '',
      bodyLabel: null,
      fields: Array.isArray(payload.fields) ? (payload.fields as QuestionField[]) : [],
    };
  }
  if (request.subject === 'instructions_update') {
    return { reason, details: [], body: text(payload.instructions), bodyLabel: 'instructions', fields: [] };
  }
  if (request.subject === 'run_start') {
    return {
      reason: '',
      details: payload.run_title ? [{ label: 'run', value: text(payload.run_title) }] : [],
      body: text(payload.brief),
      bodyLabel: 'brief',
      fields: [],
    };
  }
  if (request.subject === 'skill_save') {
    const skill = (payload.skill ?? {}) as Record<string, unknown>;
    return {
      reason,
      details: [{ label: 'skill', value: `/${text(skill.name)}` }],
      body: text(skill.body),
      bodyLabel: 'skill',
      fields: [],
    };
  }
  if (request.kind === 'login') {
    return {
      reason,
      details: [
        ...(payload.site ? [{ label: 'site', value: text(payload.site) }] : []),
        ...(payload.item_label
          ? [
              {
                label: 'item',
                value: `${text(payload.item_label)}${payload.username_hint ? ` · ${text(payload.username_hint)}` : ''}`,
              },
            ]
          : []),
      ],
      body: '',
      bodyLabel: null,
      fields: [],
    };
  }
  if (request.kind === 'takeover') return { reason, details: [], body: '', bodyLabel: null, fields: [] };
  // An approval: what it would do, as the Agent's tool described it.
  const details = Array.isArray(payload.details)
    ? payload.details.flatMap((row: unknown) => {
        if (!row || typeof row !== 'object') return [];
        const detail = row as Record<string, unknown>;
        return typeof detail.label === 'string'
          ? [
              {
                label: detail.label,
                value: text(detail.value),
                ...(detail.format === 'markdown' || detail.format === 'chips' ? { format: detail.format } : {}),
              },
            ]
          : [];
      })
    : payload.details && typeof payload.details === 'object' && !Array.isArray(payload.details)
      ? Object.entries(payload.details as Record<string, unknown>).map(([label, value]) => ({
          label,
          value: text(value),
        }))
      : [];
  return { reason, details, body: '', bodyLabel: null, fields: [] };
}

/** The answers a question form can send, or the label of the first required field left empty. */
export function checkAnswers(
  fields: readonly QuestionField[],
  answers: Readonly<Record<string, string>>,
): { ok: true; answers: Record<string, string> } | { ok: false; missing: string } {
  for (const field of fields) {
    if (field.required !== false && !answers[field.key]?.trim()) return { ok: false, missing: field.label };
  }
  const out: Record<string, string> = {};
  for (const field of fields) if (answers[field.key]?.trim()) out[field.key] = answers[field.key]!.trim();
  return { ok: true, answers: out };
}

/** Seconds left on a card that ends within the minute, else null. */
export function secondsLeft(request: Pick<NeedsYou, 'status' | 'expires_at'>, now: number): number | null {
  if (request.status !== 'pending' || !request.expires_at) return null;
  const left = Math.ceil(((parseMs(request.expires_at) || 0) - now) / 1000);
  return left >= 0 && left <= 60 ? left : null;
}

/** Only an explicit tier2 scope can be offered as a standing approval. */
export function standingScope(request: NeedsYou): 'folder' | 'table' | null {
  const scope = request.payload.standing_scope;
  if (request.kind !== 'approval' || request.payload.tier !== 'tier2' || !scope || typeof scope !== 'object')
    return null;
  const type = (scope as { type?: unknown }).type;
  return type === 'folder' || type === 'table' ? type : null;
}

/** Retired cards collapse; replacement navigation stays in their source conversation. */
export function retiredRequest(request: Pick<NeedsYou, 'status' | 'result' | 'conversation_id'>) {
  if (request.status !== 'superseded' && request.status !== 'withdrawn') return null;
  return {
    word: request.result?.reason === 'answered in chat' ? 'answeredInChat' : request.status,
    replacement:
      typeof request.result?.replacement_request_id === 'string' && request.conversation_id
        ? { id: request.conversation_id, request: request.result.replacement_request_id }
        : null,
  };
}
