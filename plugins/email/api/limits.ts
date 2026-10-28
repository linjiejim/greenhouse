/**
 * Email limits — LEAF MODULE, zero imports.
 *
 * The email tool descriptions interpolate these constants while their own
 * module bodies evaluate, and tools/registry.ts imports every tool module. If
 * these lived anywhere that reaches db/security/service code, the resulting
 * import cycle would put them in the TDZ: unit tests stay green and the API
 * dies at boot. The automation tools learned this the hard way — keep this file
 * import-free.
 */

/** Successful sends per user per rolling 24h from their own bound mailbox. */
export const MAX_PERSONAL_SENDS_PER_DAY = 50;

/**
 * Successful sends per rolling 24h from the shared greenhouse@ mailbox, across
 * all users and automation deliveries combined.
 *
 * Feishu enforces 100/day per sender (and 200 per 100s overall). Staying at 80
 * means WE reject first, with a readable error — being rejected by Feishu would
 * also take automation delivery down with it and surface as an opaque SMTP
 * failure.
 */
export const MAX_SHARED_SENDS_PER_DAY = 80;

/** Recipients (to + cc + bcc combined) allowed on a single message. */
export const MAX_RECIPIENTS_PER_MESSAGE = 10;

/** Combined attachment size for one message. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Messages a single search/list call may return. */
export const MAX_LIST_LIMIT = 50;

/** Default page size when the caller does not ask for one. */
export const DEFAULT_LIST_LIMIT = 20;

/** How long a send-confirmation draft stays valid. */
export const DRAFT_TTL_MS = 10 * 60 * 1000;

/** Pending drafts kept per user before the oldest is evicted. */
export const MAX_DRAFTS_PER_USER = 20;

/** Socket timeout for IMAP/SMTP connect + login during a connection test. */
export const CONNECTION_TEST_TIMEOUT_MS = 15_000;

/** Socket timeout for regular IMAP operations. */
export const IMAP_TIMEOUT_MS = 30_000;
