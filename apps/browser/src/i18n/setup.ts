/**
 * i18n bootstrap — registers the extension's message catalogs into the shared
 * @greenhouse/ui i18n mechanism. Import this module once per entry (side
 * panel, options) BEFORE rendering, so useT() resolves keys immediately.
 */

import { registerCoreLocaleMessages, type FlatKeys } from '@greenhouse/ui/lib/i18n';
import { en } from './en';
import { zh } from './zh';

registerCoreLocaleMessages('en', en);
registerCoreLocaleMessages('zh', zh);

/** Typed translation keys for this app (mirrors the web app's TranslationKey). */
export type TranslationKey = FlatKeys<typeof en>;
