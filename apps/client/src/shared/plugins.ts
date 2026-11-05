/** VENDORED verbatim from packages/types/src/plugins.ts. Re-copy; do not edit. */
/**
 * Station manifest — what one Greenhouse server (a "station") offers the signed-in
 * member, as data. The universal client (web, iOS, Android and desktop) renders
 * plugins from this list instead of shipping a hard-coded navigation.
 *
 * Served by `GET /api/extensions` (authenticated). The response is already cut to
 * the caller: a plugin, a nav entry, a page or an entity action the member cannot
 * use is simply absent. Clients never re-decide permissions from it; the server
 * still enforces every call.
 *
 * Compatibility rule: fields are only ever added. A client that meets a page
 * `kind` it does not know says it cannot show that page.
 */

/** A string in the source language, or a per-locale map (`en` / `zh`). */
export type LocalizedText = string | { en?: string; zh?: string };

export const STATION_MANIFEST_VERSION = 2;

/**
 * The API level the native / universal client relies on. Mirrors
 * `MOBILE_API_LEVEL` in apps/api/src/routes/bootstrap.ts.
 * 4: the station manifest (`GET /api/extensions` v2) and plugin surfaces.
 */
export const CLIENT_API_LEVEL = 4;

export interface StationManifest {
  manifest_version: typeof STATION_MANIFEST_VERSION;
  core: {
    /** Running Greenhouse version (`APP_VERSION`, else package.json). */
    version: string;
    /** Same value `/api/bootstrap` reports as `mobile_api`. */
    client_api: number;
  };
  plugins: PluginManifestEntry[];
  notificationTransports?: Array<{
    id: string;
    title: string;
    bindingSettings?: { preference: string; label: string };
    /** Accepts a group-bot webhook URL for automation results (`notify.webhook`). */
    webhook?: boolean;
  }>;
  identityProviders?: Array<{ id: string; title: string; icon: string; login: boolean; bind: boolean }>;
}

export interface PluginManifestEntry {
  id: string;
  name: LocalizedText;
  description: LocalizedText | null;
  /** The plugin's own version (official plugins carry the product version). */
  version: string;
  /** Shipped in the Greenhouse repository (`plugins/*`). */
  official: boolean;
  /** Lowest `client_api` that can render this plugin's surfaces. */
  client_min?: number;
  /** Feature flag keys this plugin owns (the member's state is in `/api/auth/me` `features`). */
  features: string[];
  /** MCP consent groups this plugin owns. */
  mcp_groups: string[];
  nav: PluginNavItem[];
  pages: PluginPage[];
  /** Declarative data entities (see `PluginEntitySchema`), cut to what the member may read. */
  entities: PluginEntitySchema[];
  /** `page`: an embed page of this plugin that opens these records (see ExtensionEntityKindDef). */
  entity_kinds: Array<{ kind: string; route: string; page?: string; icon?: string; title?: LocalizedText }>;
}

export interface PluginNavItem {
  id: string;
  label: LocalizedText;
  /** A lucide icon name (`BookOpen`); clients map it to their own icon set. */
  icon: string;
  /** The page this entry opens (`PluginPage.id`). */
  page: string;
  /** `primary` = a rail / drawer place of its own; `more` = the overflow menu. */
  placement: 'primary' | 'more';
  /** Lower first among primary entries. Core places use 0–99. */
  order?: number;
}

export type PluginPage =
  | PluginNativePage
  | PluginEntityListPage
  | PluginEntityDetailPage
  | PluginSettingsFormPage
  | PluginEmbedPage;

interface PluginPageBase {
  requireRole?: 'super' | 'team';
  id: string;
  title: LocalizedText;
}

/** A screen compiled into the client (official plugins). `screen` is a client-known id. */
export interface PluginNativePage extends PluginPageBase {
  kind: 'native';
  screen: string;
  /**
   * `administration`: a section of the Admin place (super only, served to supers alone) rather
   * than an app; keep such pages out of `nav`.
   */
  parent?: 'administration';
}

export interface PluginEntityListPage extends PluginPageBase {
  kind: 'entity-list';
  /** `<app>.<entity>`, one of `PluginManifestEntry.entities[].id`. */
  entity: string;
  /** View id inside the entity schema; default `default`. */
  view?: string;
}

export interface PluginEntityDetailPage extends PluginPageBase {
  kind: 'entity-detail';
  entity: string;
}

export interface PluginSettingsFormPage extends PluginPageBase {
  kind: 'settings-form';
  /** Workspace setting keys rendered as one form (Runtime Config semantics). */
  settings: string[];
  parent: 'settings' | 'administration';
}

/** A plugin's own static front end, framed by the host (see `EMBED_PROTOCOL`). */
export interface PluginEmbedPage extends PluginPageBase {
  kind: 'embed';
  /** Same-origin path (`/ext/crm/ui/`) or an absolute https URL. */
  url: string;
}

// ─── Declarative entities ─────────────────────────────────

export type EntityFieldKind =
  | 'text'
  | 'longText'
  | 'integer'
  | 'number'
  | 'money'
  | 'boolean'
  | 'date'
  | 'dateTime'
  | 'enum'
  | 'user'
  | 'relation'
  | 'json';

export interface EntityFieldSchema {
  key: string;
  title: LocalizedText;
  kind: EntityFieldKind;
  required?: boolean;
  /** `enum` only. */
  values?: string[];
  /** `relation` only: `<app>.<entity>`. */
  target?: string;
  searchable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  /** Writable through create / update for this member. */
  writable?: boolean;
}

export interface EntityViewSchema {
  id: string;
  title?: LocalizedText;
  columns: string[];
  filters?: string[];
  sort?: { field: string; dir: 'asc' | 'desc' };
}

export type EntityAction = 'read' | 'create' | 'update' | 'delete' | 'export';

export interface PluginEntitySchema {
  /** `<app>.<entity>`. */
  id: string;
  title: LocalizedText;
  /** Field shown as a record's title. */
  title_field: string;
  subtitle_field?: string;
  fields: EntityFieldSchema[];
  views: EntityViewSchema[];
  /** Actions this member may perform. */
  actions: EntityAction[];
  /** REST base for records: list `GET`, `GET /:id`, `POST`, `PATCH /:id`, `DELETE /:id`. */
  endpoint: string;
  /** Record kind for deeplinks / peeks (`ext:sellfox:shop`). */
  kind: string;
}

// ─── Embedded pages ──────────────────────────────────────

/**
 * postMessage protocol between a host (iframe / WebView) and a plugin's embedded
 * page. Messages are objects `{ type, ...payload }`.
 *
 * host → page:  `greenhouse:init` { theme, tokens, locale, user, route, token, expires_at }
 *               `greenhouse:theme` { theme, tokens }      (theme switched)
 *               `greenhouse:token` { token, expires_at }  (answer to a refresh request)
 * page → host:  `greenhouse:ready`                         (page loaded; host replies with init)
 *               `greenhouse:navigate` { href }             (client route or in-app object link)
 *               `greenhouse:title` { title }
 *               `greenhouse:sendPrompt` { text }           (fill the composer, never send)
 *               `greenhouse:token-refresh`
 *               `greenhouse:confirm` { id, title, body?, confirmLabel, tone? }  (host asks; replies
 *                                                          `greenhouse:confirm-result` { id, ok })
 *               `greenhouse:notify` { id, kind, text, actionLabel? } (host shows it; a press on the
 *                                                          action replies `greenhouse:notify-action` { id },
 *                                                          its end without one `greenhouse:notify-dismissed` { id })
 *               `greenhouse:header` { actions }            (icon actions in the host's title bar; a
 *                                                          press replies `greenhouse:header-action` { id })
 *               `greenhouse:route` { route }               (the page's own view, `#/…`: kept in the
 *                                                          host address so it reloads and shares)
 * Confirms and notices are drawn by the host so they cover the whole app and behave like its own.
 */
export const EMBED_PROTOCOL = {
  init: 'greenhouse:init',
  theme: 'greenhouse:theme',
  token: 'greenhouse:token',
  ready: 'greenhouse:ready',
  navigate: 'greenhouse:navigate',
  title: 'greenhouse:title',
  sendPrompt: 'greenhouse:sendPrompt',
  tokenRefresh: 'greenhouse:token-refresh',
  confirm: 'greenhouse:confirm',
  confirmResult: 'greenhouse:confirm-result',
  notify: 'greenhouse:notify',
  notifyAction: 'greenhouse:notify-action',
  notifyDismissed: 'greenhouse:notify-dismissed',
  header: 'greenhouse:header',
  headerAction: 'greenhouse:header-action',
  route: 'greenhouse:route',
} as const;

/** A confirm the page asks the host to draw. The title is a question; the button repeats its verb. */
export interface EmbedConfirmRequest {
  id: string;
  title: string;
  body?: string;
  confirmLabel: string;
  /** Defaults to Cancel; a discard prompt says Keep editing. */
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

/**
 * A notice the page asks the host to show. `success`/`info`/`warning` fade; `undo` stays 8 s with
 * its action; `error` stays until dismissed and may offer a retry action.
 */
export interface EmbedNotifyRequest {
  id: string;
  kind: 'success' | 'info' | 'warning' | 'undo' | 'error';
  text: string;
  actionLabel?: string;
}

/** An icon action the page places in the host's title bar; `icon` is a lucide name. */
export interface EmbedHeaderAction {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
}

export interface EmbedInitMessage {
  type: typeof EMBED_PROTOCOL.init;
  theme: 'light' | 'dark';
  /** CSS custom property name → value (`--gh-accent` → `#0d9488`), branding applied. */
  tokens: Record<string, string>;
  locale: 'en' | 'zh';
  user: { id: string; name: string; role: 'super' | 'team' };
  /** Path inside the plugin page (`companies/42`). */
  route: string;
  /** Short-lived bearer for `/api/ext/<id>/*` and `/api/me` (see `POST /api/ext-ui/token`). */
  token: string;
  expires_at: string;
}

/** Resolve a `LocalizedText` for a locale, falling back to English, then any value. */
export function localize(text: LocalizedText | null | undefined, locale: 'en' | 'zh'): string {
  if (text == null) return '';
  if (typeof text === 'string') return text;
  return text[locale] ?? text.en ?? text.zh ?? '';
}
