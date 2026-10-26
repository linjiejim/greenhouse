/**
 * The workspace brand a report is rendered in — the same three facts the
 * Branding Studio sets for the app itself: product name, logo, brand colour.
 * Unset values fall back to the V1 defaults (Greenhouse, no logo, V1 green).
 *
 * The logo is a data URL (PNG / JPEG / SVG / WebP, ≤ 256 KB). Each format
 * embeds what it can: PDF takes all but WebP, PowerPoint takes PNG/JPEG/SVG,
 * Word takes PNG/JPEG. A logo a format cannot carry is left out with a
 * warning rather than failing the render.
 */

import { getWorkspaceBootstrap } from '@greenhouse/api/extension-kit';

/** The V1 green (`--primary-500`, rgb 46 139 61). */
export const DEFAULT_BRAND_COLOR = '#2E8B3D';
export const DEFAULT_BRAND_NAME = 'Greenhouse';

export type ReportLogoKind = 'png' | 'jpeg' | 'svg' | 'webp';

export interface ReportLogo {
  kind: ReportLogoKind;
  bytes: Buffer;
  /** Intrinsic size (px), for keeping the aspect ratio; null when unknown. */
  width: number | null;
  height: number | null;
}

export interface ReportBrand {
  name: string;
  /** #RRGGBB */
  color: string;
  logo: ReportLogo | null;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export async function resolveReportBrand(): Promise<ReportBrand> {
  const boot = await getWorkspaceBootstrap();
  const color = boot.theme_tokens?.brand && HEX_RE.test(boot.theme_tokens.brand) ? boot.theme_tokens.brand : null;
  return {
    name: boot.product_name?.trim() || DEFAULT_BRAND_NAME,
    color: (color ?? DEFAULT_BRAND_COLOR).toUpperCase(),
    logo: boot.logo ? parseLogoDataUrl(boot.logo) : null,
  };
}

const MIME_KIND: Record<string, ReportLogoKind> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

/** A logo data URL as bytes + kind + size; null when it is not one we understand. */
export function parseLogoDataUrl(url: string): ReportLogo | null {
  const match = /^data:([^;,]+)((?:;[^;,]+)*),(.*)$/s.exec(url.trim());
  if (!match) return null;
  const kind = MIME_KIND[match[1]!.toLowerCase()];
  if (!kind) return null;
  const isBase64 = match[2]!.split(';').includes('base64');
  let bytes: Buffer;
  try {
    bytes = isBase64 ? Buffer.from(match[3]!, 'base64') : Buffer.from(decodeURIComponent(match[3]!), 'utf8');
  } catch {
    return null;
  }
  if (bytes.length === 0) return null;
  const size = imageSize(kind, bytes);
  return { kind, bytes, width: size?.width ?? null, height: size?.height ?? null };
}

function imageSize(kind: ReportLogoKind, bytes: Buffer): { width: number; height: number } | null {
  try {
    if (kind === 'png') {
      if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (kind === 'jpeg') {
      let at = 2;
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1]!;
        const length = bytes.readUInt16BE(at + 2);
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
        at += 2 + length;
      }
      return null;
    }
    if (kind === 'svg') {
      const head = bytes.toString('utf8', 0, Math.min(bytes.length, 4096));
      const tag = /<svg\b[^>]*>/i.exec(head)?.[0] ?? '';
      const num = (name: string) => {
        const value = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, 'i').exec(tag)?.[1];
        return value ? Number(value) : null;
      };
      const width = num('width');
      const height = num('height');
      if (width && height) return { width, height };
      const box = /\bviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i.exec(tag);
      if (box) return { width: Number(box[1]), height: Number(box[2]) };
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Fit a logo into a box (points), keeping its aspect ratio; square when the size is unknown. */
export function fitLogo(logo: ReportLogo, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const ratio = logo.width && logo.height ? logo.width / logo.height : 1;
  let height = maxHeight;
  let width = height * ratio;
  if (width > maxWidth) {
    width = maxWidth;
    height = width / ratio;
  }
  return { width: Math.round(width * 100) / 100, height: Math.round(height * 100) / 100 };
}

/** `#2E8B3D` → `2E8B3D` (docx / pptx colour form). */
export function bareHex(color: string): string {
  return color.replace(/^#/, '').toUpperCase();
}

/** Mix a colour toward white: amount 0 = the colour, 1 = white. */
export function tint(color: string, amount: number): string {
  const hex = bareHex(color);
  const channel = (i: number) => {
    const value = parseInt(hex.slice(i, i + 2), 16);
    return Math.round(value + (255 - value) * amount)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(2)}${channel(4)}`.toUpperCase();
}
