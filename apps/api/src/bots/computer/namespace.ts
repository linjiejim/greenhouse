/**
 * Names and labels of the Docker objects behind an Agent's computer.
 *
 * Everything carries the deployment namespace (config.ts) so worktrees and
 * deployments sharing one daemon never touch each other's computers, and every
 * container and volume is labelled so reconcile can find orphans with a single
 * filtered `docker ps` / `docker volume ls`.
 *
 * Identity is sticky: the names are written to `bot_computers` on first use
 * and read back from the row afterwards, so a later namespace change never
 * strands a member's home volume.
 */

export const LABEL_COMPUTER = 'greenhouse.bots.computer';
export const LABEL_NAMESPACE = 'greenhouse.bots.computer.namespace';
export const LABEL_USER = 'greenhouse.bots.computer.user';
/** Image labels (apps/bot-computer/Dockerfile, scripts/build-bot-computer.sh). */
export const LABEL_IMAGE_CONTRACT = 'greenhouse.bots.computer.contract';
export const LABEL_IMAGE_CHROMIUM = 'greenhouse.bots.computer.chromium';
/** Operator-chosen apt packages baked in at build time (BOTS_COMPUTER_EXTRA_PACKAGES); empty = none. */
export const LABEL_IMAGE_EXTRA_PACKAGES = 'greenhouse.bots.computer.extra-packages';

/** The computer's id (`bot_computers.id`); absent on objects made before 2026-10-12 (they are main computers). */
export const LABEL_COMPUTER_ID = 'greenhouse.bots.computer.id';

/**
 * One computer per Agent (spec 20261011-agent-first-class P3a, D28/D29). A member's main Agent
 * (Sprouty) has the computer whose id is the member's user id — every computer made before
 * per-Agent computers, so its names, locks and labels never changed; any other Agent's id is
 * `<userId>.<botId>`. Deterministic, so two API slots agree without a lookup.
 */
export interface ComputerRef {
  id: string;
  userId: string;
  /** null = the member's main Agent. */
  botId: string | null;
}

export function computerRef(userId: string, botId: string | null): ComputerRef {
  if (!userId || userId.includes('.')) throw new Error('A computer needs a plain user id');
  return { id: botId ? `${userId}.${botId}` : userId, userId, botId };
}

/** The computer of this Agent: the main one for Sprouty, its own for any other. */
export function computerRefForBot(userId: string, bot: { id: string; template_key?: string | null }): ComputerRef {
  return computerRef(userId, bot.template_key === 'sprouty' ? null : bot.id);
}

/** Back from an id (user ids never contain a dot; Bot ids are `bot_<hex>`). */
export function parseComputerId(id: string): ComputerRef {
  const dot = id.indexOf('.');
  return dot < 0 ? computerRef(id, null) : computerRef(id.slice(0, dot), id.slice(dot + 1));
}

/** User ids are UUIDs, Bot ids `bot_<hex>`; keep only what a Docker name allows, bounded. */
function slug(id: string): string {
  const cleaned = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cleaned) throw new Error('A computer needs a non-empty id');
  return cleaned.slice(0, 40);
}

function computerSlug(ref: ComputerRef): string {
  return ref.botId ? `${slug(ref.userId)}-${slug(ref.botId)}` : slug(ref.userId);
}

export function computerContainerName(namespace: string, ref: ComputerRef): string {
  return `gh-computer-${namespace}-${computerSlug(ref)}`;
}

export function computerVolumeName(namespace: string, ref: ComputerRef): string {
  return `gh-computer-${namespace}-${computerSlug(ref)}-home`;
}

/** What a `bot_computers` row is created with (the names are sticky afterwards). */
export function computerIdentity(
  namespace: string,
  ref: ComputerRef,
): {
  id: string;
  user_id: string;
  bot_id: string | null;
  namespace: string;
  container_name: string;
  volume_name: string;
} {
  return {
    id: ref.id,
    user_id: ref.userId,
    bot_id: ref.botId,
    namespace,
    container_name: computerContainerName(namespace, ref),
    volume_name: computerVolumeName(namespace, ref),
  };
}

/** The development-mode bridge the API creates itself (hardened hosts configure their own). */
export function managedNetworkName(namespace: string): string {
  return `gh-bots-${namespace}`;
}

export function computerLabels(namespace: string, computerId: string): Record<string, string> {
  const ref = parseComputerId(computerId);
  return {
    [LABEL_COMPUTER]: '1',
    [LABEL_NAMESPACE]: namespace,
    [LABEL_USER]: ref.userId,
    [LABEL_COMPUTER_ID]: ref.id,
  };
}

/** The computer an object belongs to, from its labels (older objects carry only the user: a main computer). */
export function computerIdFromLabels(labels: Record<string, string | undefined>): string | null {
  return labels[LABEL_COMPUTER_ID] || labels[LABEL_USER] || null;
}

/** `docker … --filter label=…` value selecting this namespace's objects. */
export function namespaceFilter(namespace: string): string {
  return `${LABEL_NAMESPACE}=${namespace}`;
}
