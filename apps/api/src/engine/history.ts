/**
 * The transcript as the speaking Agent sees it. Its own replies are assistant messages; everyone
 * else's words arrive as user messages behind a speaker label the model cannot forge (a label at
 * the start of a message body is neutralised into a quote). Older messages beyond the budget live
 * on in the rolling summary.
 */

import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm';
import {
  estimateTokens,
  resolveHistoryBudget,
  windowMessagesByBudget,
  type EngineContentPart,
  type EngineMessage,
} from '@greenhouse/agent-core';
import { agents, getDb, members, messages, type Conversation, type Message } from '@greenhouse/db';
import { skillRuns } from '../modules/skills/turn.js';
import { sanitizeForPrompt } from '../security/prompt.js';
import { SPEAKER } from './prompt.js';

/** Text that opens like a speaker label is quoted, so nobody can speak as somebody else. */
function neutralise(text: string): string {
  return /^\s*\[[^\]\n]{1,80}\]/.test(text) ? `> ${text}` : text;
}

function eventLine(event: Record<string, unknown> | null, content: string): string {
  const text = content.trim() || (typeof event?.text === 'string' ? event.text : '');
  return `${SPEAKER.event} ${sanitizeForPrompt(text, 2000)}`;
}

export interface Projection {
  messages: EngineMessage[];
  /** Estimated tokens of the projected transcript, for deciding when to summarise. */
  tokens: number;
  /** The newest message the projection includes. */
  uptoSeq: number;
}

/**
 * Projects the messages after the summary, leaving out the reply being written. A room labels
 * the asker as the member and other people as participants.
 */
export async function projectHistory(input: {
  conversation: Conversation;
  agentId: string;
  askerId: string;
  excludeMessageId?: string;
  contextWindow?: number;
}): Promise<Projection> {
  const db = getDb();
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversation.id),
        gt(messages.seq, input.conversation.digestUptoSeq),
        input.excludeMessageId ? ne(messages.id, input.excludeMessageId) : undefined,
      ),
    )
    .orderBy(asc(messages.seq));
  const memberIds = [...new Set(rows.map((row) => row.authorMemberId).filter((id): id is string => !!id))];
  const agentIds = [...new Set(rows.map((row) => row.agentId).filter((id): id is string => !!id))];
  const [people, speakers] = await Promise.all([
    memberIds.length
      ? db.select({ id: members.id, name: members.name }).from(members).where(inArray(members.id, memberIds))
      : [],
    agentIds.length
      ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
      : [],
  ]);
  const personName = new Map(people.map((row) => [row.id, row.name]));
  const agentName = new Map(speakers.map((row) => [row.id, row.name]));
  const room = input.conversation.kind === 'room';
  // The asker's `/` runs carry their skill's text; anyone else's are only named.
  const runs = await skillRuns(rows, input.askerId);

  const projected: Array<EngineMessage & { seq: number }> = [];
  for (const row of rows) {
    const text = render(row, runs.get(row.id));
    if (!text) continue;
    if (row.role === 'assistant' && row.agentId === input.agentId) {
      projected.push({ role: 'assistant', content: text, seq: row.seq });
      continue;
    }
    let content: string;
    if (row.role === 'event') content = eventLine(row.event, text);
    else if (row.role === 'assistant')
      content = `${SPEAKER.agent(agentName.get(row.agentId ?? '') ?? 'Agent')} ${neutralise(text)}`;
    else {
      const name = personName.get(row.authorMemberId ?? '') ?? 'Member';
      const label = !room || row.authorMemberId === input.askerId ? SPEAKER.member(name) : SPEAKER.participant(name);
      content = room ? `${label} ${neutralise(text)}` : neutralise(text);
    }
    projected.push({ role: 'user', content, created_at: row.createdAt, seq: row.seq });
  }

  // Consecutive messages from others become one user message: some vendors reject two in a row.
  const merged: Array<EngineMessage & { seq: number }> = [];
  for (const message of projected) {
    const last = merged[merged.length - 1];
    if (last && last.role === 'user' && message.role === 'user' && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${message.content as string}`;
      last.seq = message.seq;
      continue;
    }
    merged.push({ ...message });
  }

  const budget = resolveHistoryBudget(input.contextWindow);
  const windowed = windowMessagesByBudget(
    merged.map((message) => ({ ...message, content: message.content as string })),
    budget,
  );
  const kept = windowed.messages;
  return {
    messages: kept.map(({ seq: _seq, ...message }) => message),
    tokens: merged.reduce((sum, message) => sum + estimateTokens(message.content as string), 0),
    uptoSeq: rows.length ? rows[rows.length - 1]!.seq : input.conversation.digestUptoSeq,
  };
}

/** A message as text: its content, the quote it answers, the skill it ran and the files it carries. */
function render(row: Message, skillRun?: string): string {
  const parts: string[] = [];
  if (row.quote?.text) parts.push(`> ${row.quote.text.replace(/\n/g, '\n> ')}`);
  // Only a real run carries a <skill_run> block; typed text cannot pose as one.
  if (row.content.trim()) parts.push(row.content.replace(/<(\/?)skill_run/gi, '‹$1skill_run'));
  if (skillRun) parts.push(skillRun);
  if (row.attachments.length) parts.push(`(attachments: ${row.attachments.join(', ')})`);
  if (row.status === 'stopped') parts.push('(stopped before finishing)');
  return parts.join('\n\n');
}

/**
 * Appends the turn's closing message (and the images the member just sent). When the
 * transcript already ends with a user message, the closing text joins it as one string:
 * some vendors reject two user messages in a row, or a user message made of several parts.
 */
export function closeTranscript(
  transcript: EngineMessage[],
  tail: string,
  images: EngineContentPart[] = [],
): EngineMessage[] {
  const content = (text: string) => (images.length ? [{ type: 'text' as const, text }, ...images] : text);
  const last = transcript[transcript.length - 1];
  if (last?.role === 'user' && typeof last.content === 'string') {
    return [...transcript.slice(0, -1), { ...last, content: content(`${last.content}\n\n${tail}`) }];
  }
  return [...transcript, { role: 'user', content: content(tail) }];
}
