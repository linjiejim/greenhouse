/**
 * Names and labels of the Docker objects behind a member's computer.
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

/** User ids are UUIDs; keep only what a Docker name allows, bounded. */
function slug(userId: string): string {
  const cleaned = userId.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cleaned) throw new Error('A computer needs a non-empty user id');
  return cleaned.slice(0, 40);
}

export function computerContainerName(namespace: string, userId: string): string {
  return `gh-computer-${namespace}-${slug(userId)}`;
}

export function computerVolumeName(namespace: string, userId: string): string {
  return `gh-computer-${namespace}-${slug(userId)}-home`;
}

/** The development-mode bridge the API creates itself (hardened hosts configure their own). */
export function managedNetworkName(namespace: string): string {
  return `gh-bots-${namespace}`;
}

export function computerLabels(namespace: string, userId: string): Record<string, string> {
  return { [LABEL_COMPUTER]: '1', [LABEL_NAMESPACE]: namespace, [LABEL_USER]: userId };
}

/** `docker … --filter label=…` value selecting this namespace's objects. */
export function namespaceFilter(namespace: string): string {
  return `${LABEL_NAMESPACE}=${namespace}`;
}
