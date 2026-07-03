/**
 * Browser-automation permission policy.
 *
 * Three effective trust levels for the write actions (browser_click /
 * browser_type — reads always run):
 * - 'ask'  (default): confirm every write.
 * - 'auto': confirm only DANGEROUS writes (password/payment fields, form
 *   submits, sensitive domains); ordinary clicks/typing run automatically.
 * - per-site YOLO: a host the user explicitly opted in — every write on it
 *   runs without confirmation, overriding the global mode.
 *
 * The global mode and the YOLO host set persist in chrome.storage.local. The
 * "don't ask again on this site" grant is session-scoped (panel/conversation
 * lifetime) and lives in memory in use-chat — deliberately NOT persisted.
 *
 * The decision function is pure so it can be unit-tested without chrome APIs.
 */

export type AutomationMode = 'ask' | 'auto';

const MODE_KEY = 'automation-mode';
const YOLO_SITES_KEY = 'automation-yolo-sites';

/** Danger signals gathered from the target element / page before a write. */
export interface ActionSignals {
  /** Target is a password field. */
  isPassword?: boolean;
  /** Target is a payment/credit-card field (autocomplete cc-*). */
  isPayment?: boolean;
  /** The action submits a form (submit button, or typing + Enter inside a form). */
  willSubmit?: boolean;
  /** The page host is on the built-in sensitive-domain list (bank/pay/email...). */
  isSensitiveDomain?: boolean;
}

export type Decision = 'allow' | 'ask';

/**
 * Built-in sensitive host substrings — matched against the page host. Auto mode
 * still asks on these even for an "ordinary" click. Intentionally conservative;
 * a full user-editable list is a later enhancement.
 */
const SENSITIVE_HOST_PATTERNS = [
  'bank',
  'paypal',
  'stripe',
  'checkout',
  'wallet',
  'alipay',
  'mail.google',
  'outlook',
  'coinbase',
  'binance',
];

export function isSensitiveHost(host: string | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return SENSITIVE_HOST_PATTERNS.some((p) => h.includes(p));
}

function isDangerous(signals: ActionSignals): boolean {
  return Boolean(signals.isPassword || signals.isPayment || signals.willSubmit || signals.isSensitiveDomain);
}

/**
 * Decide whether a write action needs user confirmation. Pure — all state is
 * passed in.
 *
 * @param host - page host (null/undefined ⇒ treated as unknown, never YOLO-matched)
 * @param yoloSites - hosts the user opted into per-site YOLO
 * @param sessionAllowed - hosts granted "don't ask again this session"
 */
export function decideAction(
  mode: AutomationMode,
  host: string | undefined,
  signals: ActionSignals,
  yoloSites: ReadonlySet<string>,
  sessionAllowed: ReadonlySet<string>,
): Decision {
  if (host && yoloSites.has(host)) return 'allow';
  if (host && sessionAllowed.has(host)) return 'allow';
  if (mode === 'auto' && !isDangerous(signals)) return 'allow';
  return 'ask';
}

// ─── Persistence (chrome.storage.local) ──────────────────

export async function getMode(): Promise<AutomationMode> {
  const rec = await chrome.storage.local.get(MODE_KEY);
  return rec[MODE_KEY] === 'auto' ? 'auto' : 'ask';
}

export async function setMode(mode: AutomationMode): Promise<void> {
  await chrome.storage.local.set({ [MODE_KEY]: mode });
}

export async function getYoloSites(): Promise<Set<string>> {
  const rec = await chrome.storage.local.get(YOLO_SITES_KEY);
  const list = rec[YOLO_SITES_KEY];
  return new Set(Array.isArray(list) ? (list as string[]) : []);
}

export async function setYoloSite(host: string, on: boolean): Promise<Set<string>> {
  const sites = await getYoloSites();
  if (on) sites.add(host);
  else sites.delete(host);
  await chrome.storage.local.set({ [YOLO_SITES_KEY]: [...sites] });
  return sites;
}

/** Extract the host from a URL (for keying YOLO / session grants). */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
