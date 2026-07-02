/**
 * i18n — app layer over the @greenhouse/ui i18n mechanism.
 *
 * The mechanism (I18nProvider, useT/useI18n, fork registerLocaleMessages,
 * locale storage) lives in @greenhouse/ui/lib/i18n. The message CATALOGS stay
 * here (en.ts / zh.ts) and are registered at import time, so importing this
 * module anywhere (app.tsx does) wires the core translations before render.
 * TranslationKey keeps compile-time autocomplete over the core en catalog.
 */

import { registerCoreLocaleMessages } from '@greenhouse/ui/lib/i18n';
import type { FlatKeys } from '@greenhouse/ui/lib/i18n';
import en from './en';
import zh from './zh';

export * from '@greenhouse/ui/lib/i18n';

export type LocaleMessages = typeof en;

/** Dot-notation path into the messages object, e.g. "chat.newConversation" */
export type TranslationKey = FlatKeys<LocaleMessages>;

registerCoreLocaleMessages('en', en);
registerCoreLocaleMessages('zh', zh as unknown as Record<string, unknown>);
