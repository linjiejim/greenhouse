/**
 * Greenhouse colours for RN content, as strings (React-free, so ./palette.test.ts checks contrast
 * without a native install). Every value comes from the shared token module
 * (packages/ui/src/tokens/tokens.ts) through ./tokens.generated.ts — run `pnpm tokens:build` at the
 * repo root after changing a token; never edit a hex here.
 *
 * Light: Haven forest green on neutral, faintly green surfaces. Dark: content surfaces keep
 * UIKit's system base (#000 under #1C1C1E grouped cells) so RN content and native Hosts never mix
 * traits; the accent is the pale sage. Native controls keep system styling with the accent as tint.
 */

import { categoricalHex, nativePalette } from './tokens.generated';

type Widen<T> = { [K in keyof T]: string };

export type HexPalette = Widen<typeof nativePalette.light>;

export const lightHex: HexPalette = { ...nativePalette.light };
export const darkHex: HexPalette = { ...nativePalette.dark };

export type CategoricalName = keyof typeof categoricalHex.light;
export type CategoricalPair = { fg: string; fill: string };

/** User-chosen colours (project and tag colours) as fg-on-fill pairs per appearance. */
export const categorical: Record<'light' | 'dark', Record<CategoricalName, CategoricalPair>> = categoricalHex;
