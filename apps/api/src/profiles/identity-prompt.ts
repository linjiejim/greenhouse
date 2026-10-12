/**
 * The identity sections every prompt assembler shares (spec 20261007 §2.3).
 *
 * One Bot definition runs in two conversation modes — a Chat session (fresh
 * context) and a Bots thread — and both must introduce the model to itself the
 * same way: who it is (name, role), the instructions its owner wrote, and the
 * member's own standing notes. The Bots engine renders these as S2 / S3; the
 * Chat path prepends them to the preset's static rules. Everything user-written
 * is sanitised before it reaches the prompt.
 */

import { sanitizeForPrompt } from '../security/security.js';

export interface PromptIdentity {
  name: string;
  role: string;
  instructions: string;
}

/** S2 — the Bot's identity and the instructions the member wrote or approved. */
export function buildIdentitySection(identity: PromptIdentity, nickname: string | null | undefined): string {
  const role = identity.role.trim() ? ` — ${sanitizeForPrompt(identity.role.trim())}` : '';
  const member = nickname?.trim() ? sanitizeForPrompt(nickname.trim()) : null;
  const parts = [
    `## Who you are`,
    `You are **${sanitizeForPrompt(identity.name)}**${role}.${member ? ` You work for ${member}.` : ''}`,
  ];
  const instructions = identity.instructions.trim();
  if (instructions) {
    parts.push(``, `## Your instructions${member ? ` (from ${member})` : ''}`, sanitizeForPrompt(instructions));
  }
  return parts.join('\n');
}

/**
 * S2 for a public Agent talking to someone other than its owner (spec 20261011-agent-first-class P4):
 * who published it, whom it helps now, and that only what was granted to it exists for it. The
 * scripted-model test helper finds the Bot by the `You are **Name**` line, as for S2.
 */
export function buildPublicIdentitySection(
  identity: PromptIdentity,
  ownerNickname: string,
  memberNickname: string | null | undefined,
): string {
  const role = identity.role.trim() ? ` — ${sanitizeForPrompt(identity.role.trim())}` : '';
  const owner = sanitizeForPrompt(ownerNickname.trim() || 'a colleague');
  const member = memberNickname?.trim() ? sanitizeForPrompt(memberNickname.trim()) : 'a colleague';
  const parts = [
    `## Who you are`,
    `You are **${sanitizeForPrompt(identity.name)}**${role}, an Agent ${owner} published for colleagues. You are now helping ${member} — not ${owner}.`,
    `Only what ${owner} granted you exists for you: the knowledge shared with you, and the other tools you have. You do not know anything private about ${member} beyond what they tell you here; your notes about them are yours alone. Never claim to have done something you have no tool for.`,
  ];
  const instructions = identity.instructions.trim();
  if (instructions) parts.push(``, `## Your instructions (from ${owner})`, sanitizeForPrompt(instructions));
  return parts.join('\n');
}

/** S3 — the member's standing preferences (users.notes). */
export function buildMemberNotesSection(
  nickname: string | null | undefined,
  notes: string | null | undefined,
): string | null {
  const text = notes?.trim();
  if (!text) return null;
  const member = nickname?.trim() ? sanitizeForPrompt(nickname.trim()) : 'the member';
  return `## About ${member}\nThey have set these preferences — follow them:\n${sanitizeForPrompt(text)}`;
}

/**
 * The preset's own name when no member context is available (a headless
 * caller that resolved `sprouty` without a user): the static rules below it
 * are identity-neutral, so the model still needs to be told who it is.
 */
export function buildFallbackIdentitySection(presetName: string): string {
  return `## Who you are\nYou are **${sanitizeForPrompt(presetName)}**, the team's AI assistant inside Greenhouse.`;
}
