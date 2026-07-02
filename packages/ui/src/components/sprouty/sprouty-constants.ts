/**
 * Sprouty constants — colors, sizes, variants, accessory metadata, specialist presets.
 */

// ─── Sizes ───────────────────────────────────────────────

export const SPROUTY_SIZES = {
  xs: 24,
  sm: 32,
  md: 48,
  lg: 80,
  xl: 120,
} as const;

export type SproutySize = keyof typeof SPROUTY_SIZES;

// ─── States ──────────────────────────────────────────────

export type SproutyState = 'idle' | 'thinking' | 'responding' | 'done' | 'error';

// ─── Variants ────────────────────────────────────────────

export type SproutyVariant = 'default' | 'team' | 'custom';

// ─── Color Presets ───────────────────────────────────────

export interface SproutyColorSet {
  body: string;
  bodyDark: string;
  bodyHighlight: string;
  leaf: string;
  leafDark: string;
  leafLight: string;
}

export const COLOR_PRESETS: Record<string, SproutyColorSet> = {
  forest: {
    body: '#a4d65e',
    bodyDark: '#6a9e30',
    bodyHighlight: '#c4ee78',
    leaf: '#6abf4b',
    leafDark: '#4a8f2b',
    leafLight: '#8adf6b',
  },
  ocean: {
    body: '#5eb8d6',
    bodyDark: '#308a9e',
    bodyHighlight: '#78d8ee',
    leaf: '#4ba5bf',
    leafDark: '#2b7a8f',
    leafLight: '#6bc5df',
  },
  blossom: {
    body: '#d65ea4',
    bodyDark: '#9e306a',
    bodyHighlight: '#ee78c4',
    leaf: '#bf4b8a',
    leafDark: '#8f2b6a',
    leafLight: '#df6baa',
  },
  sunset: {
    body: '#d6a45e',
    bodyDark: '#9e6a30',
    bodyHighlight: '#eec478',
    leaf: '#bf8a4b',
    leafDark: '#8f6a2b',
    leafLight: '#dfaa6b',
  },
  lavender: {
    body: '#a45ed6',
    bodyDark: '#6a309e',
    bodyHighlight: '#c478ee',
    leaf: '#8a4bbf',
    leafDark: '#6a2b8f',
    leafLight: '#aa6bdf',
  },
  sunshine: {
    body: '#d6d65e',
    bodyDark: '#9e9e30',
    bodyHighlight: '#eeee78',
    leaf: '#bfbf4b',
    leafDark: '#8f8f2b',
    leafLight: '#dfdf6b',
  },
  midnight: {
    body: '#5ed6c4',
    bodyDark: '#309e8a',
    bodyHighlight: '#78eede',
    leaf: '#4bbfaa',
    leafDark: '#2b8f7a',
    leafLight: '#6bdfca',
  },
  autumn: {
    body: '#d68a5e',
    bodyDark: '#9e5a30',
    bodyHighlight: '#eeaa78',
    leaf: '#bf724b',
    leafDark: '#8f522b',
    leafLight: '#df926b',
  },
};

export const DEFAULT_COLORS = COLOR_PRESETS.forest;

// ─── Leaf Styles ─────────────────────────────────────────

export type LeafStyle = 'normal' | 'big' | 'mini' | 'double';

export const LEAF_STYLES: { id: LeafStyle; name: string; emoji: string }[] = [
  { id: 'normal', name: 'Normal', emoji: '🌿' },
  { id: 'big', name: 'Big', emoji: '🌳' },
  { id: 'mini', name: 'Mini', emoji: '🌱' },
  { id: 'double', name: 'Double', emoji: '🍀' },
];

// ─── Accessories ─────────────────────────────────────────

export type AccessoryType = 'hat' | 'glasses' | 'held';

export interface AccessoryMeta {
  id: string;
  name: string;
  type: AccessoryType;
  emoji: string;
}

export const ACCESSORIES: AccessoryMeta[] = [
  // Hats
  { id: 'crown', name: 'Crown', type: 'hat', emoji: '👑' },
  { id: 'cap', name: 'Baseball Cap', type: 'hat', emoji: '🧢' },
  { id: 'graduation', name: 'Graduation Cap', type: 'hat', emoji: '🎓' },
  { id: 'headset', name: 'Headset', type: 'hat', emoji: '🎧' },
  // Glasses
  { id: 'round-glasses', name: 'Round Glasses', type: 'glasses', emoji: '🤓' },
  { id: 'sunglasses', name: 'Sunglasses', type: 'glasses', emoji: '😎' },
  // Held items
  { id: 'coffee', name: 'Coffee Cup', type: 'held', emoji: '☕' },
  { id: 'wrench', name: 'Wrench', type: 'held', emoji: '🔧' },
  { id: 'magnifier', name: 'Magnifier', type: 'held', emoji: '🔍' },
  { id: 'pencil', name: 'Pencil', type: 'held', emoji: '✏️' },
  { id: 'clipboard', name: 'Clipboard', type: 'held', emoji: '📋' },
  { id: 'chart', name: 'Bar Chart', type: 'held', emoji: '📊' },
];

// ─── Avatar Configuration ────────────────────────────────

export interface SproutyAvatarConfig {
  color: string;
  accessories: string[];
  leafStyle?: LeafStyle;
}

// ─── Specialist Presets ──────────────────────────────────

export const SPECIALIST_AVATARS: Record<string, SproutyAvatarConfig> = {
  researcher: {
    color: 'ocean',
    accessories: ['round-glasses', 'magnifier'],
    leafStyle: 'big',
  },
  writer: {
    color: 'blossom',
    accessories: ['graduation', 'pencil'],
  },
  'project-assistant': {
    color: 'sunset',
    accessories: ['cap', 'clipboard'],
  },
  'cs-quality': {
    color: 'lavender',
    accessories: ['headset'],
  },
  'ops-analyst': {
    color: 'midnight',
    accessories: ['sunglasses', 'chart'],
  },
  'cc-analyzer': {
    color: 'autumn',
    accessories: ['round-glasses', 'wrench'],
  },
};
