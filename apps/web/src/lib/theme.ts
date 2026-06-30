/**
 * Theme system — CSS variable-based color theming.
 *
 * 7+ themes: Teal Garden, Forest, Ocean, Blossom, Harvest, Rose, Midnight (dark).
 * Each theme defines primary-50 through primary-900 as RGB triplets.
 * Dark themes have `dark: true` and provide surface/text/border overrides
 * via the --t-* CSS variable layer defined in app.css.
 */

export interface ThemeDef {
  key: string;
  label: string;
  emoji: string;
  description: string;
  /** Whether this is a dark-background theme */
  dark?: boolean;
  /** Primary color palette (RGB triplets for Tailwind alpha support) */
  primary: {
    50: string;
    100: string;
    200: string;
    300: string;
    400: string;
    500: string;
    600: string;
    700: string;
    800: string;
    900: string;
  };
  /** Optional surface/text/border overrides for dark themes */
  surface?: {
    surface: string;
    surfaceRaised: string;
    surfaceMuted: string;
    surfaceSunken: string;
    fg: string;
    fgSecondary: string;
    fgMuted: string;
    fgFaint: string;
    edge: string;
    edgeStrong: string;
    // Semantic status colors for dark
    success: string;
    successSubtle: string;
    successFg: string;
    warning: string;
    warningSubtle: string;
    warningFg: string;
    danger: string;
    dangerSubtle: string;
    dangerFg: string;
    info: string;
    infoSubtle: string;
    infoFg: string;
  };
}

export const THEMES: ThemeDef[] = [
  {
    key: 'teal',
    label: 'Teal Garden',
    emoji: '🌿',
    description: '清新自然，品牌经典色',
    primary: {
      50: '240 253 250',
      100: '204 251 241',
      200: '153 246 228',
      300: '94 234 212',
      400: '45 212 191',
      500: '20 184 166',
      600: '13 148 136',
      700: '15 118 110',
      800: '17 94 89',
      900: '19 78 74',
    },
  },
  {
    key: 'forest',
    label: 'Forest',
    emoji: '🌲',
    description: '浓郁绿意，自然生长',
    primary: {
      50: '240 253 244',
      100: '220 252 231',
      200: '187 247 208',
      300: '134 239 172',
      400: '74 222 128',
      500: '34 197 94',
      600: '22 163 74',
      700: '21 128 61',
      800: '22 101 52',
      900: '20 83 45',
    },
  },
  {
    key: 'ocean',
    label: 'Ocean',
    emoji: '🌊',
    description: '稳重专业，科技蓝',
    primary: {
      50: '239 246 255',
      100: '219 234 254',
      200: '191 219 254',
      300: '147 197 253',
      400: '96 165 250',
      500: '59 130 246',
      600: '37 99 235',
      700: '29 78 216',
      800: '30 64 175',
      900: '30 58 138',
    },
  },
  {
    key: 'blossom',
    label: 'Blossom',
    emoji: '🌸',
    description: '优雅花漾，独特个性',
    primary: {
      50: '250 245 255',
      100: '243 232 255',
      200: '233 213 255',
      300: '216 180 254',
      400: '192 132 252',
      500: '168 85 247',
      600: '147 51 234',
      700: '126 34 206',
      800: '107 33 168',
      900: '88 28 135',
    },
  },
  {
    key: 'harvest',
    label: 'Harvest',
    emoji: '🌅',
    description: '温暖活力，丰收喜悦',
    primary: {
      50: '255 247 237',
      100: '255 237 213',
      200: '254 215 170',
      300: '253 186 116',
      400: '251 146 60',
      500: '249 115 22',
      600: '234 88 12',
      700: '194 65 12',
      800: '154 52 18',
      900: '124 45 18',
    },
  },
  {
    key: 'rose',
    label: 'Rose',
    emoji: '🌹',
    description: '热情现代，时尚大胆',
    primary: {
      50: '255 241 242',
      100: '255 228 230',
      200: '254 205 211',
      300: '253 164 175',
      400: '251 113 133',
      500: '244 63 94',
      600: '225 29 72',
      700: '190 18 60',
      800: '159 18 57',
      900: '136 19 55',
    },
  },
  {
    key: 'midnight',
    label: 'Midnight',
    emoji: '🌙',
    description: '深邃暗夜，护眼暗色',
    dark: true,
    primary: {
      50: '238 242 255',
      100: '224 231 255',
      200: '199 210 254',
      300: '165 180 252',
      400: '129 140 248',
      500: '99 102 241',
      600: '79 70 229',
      700: '67 56 202',
      800: '55 48 163',
      900: '49 46 129',
    },
    surface: {
      surface: '#0f172a',
      surfaceRaised: '#1e293b',
      surfaceMuted: '#334155',
      surfaceSunken: '#0f172a',
      fg: '#f8fafc',
      fgSecondary: '#cbd5e1',
      fgMuted: '#94a3b8',
      fgFaint: '#64748b',
      edge: '#334155',
      edgeStrong: '#475569',
      success: '#34d399',
      successSubtle: 'rgba(16, 185, 129, 0.12)',
      successFg: '#6ee7b7',
      warning: '#fbbf24',
      warningSubtle: 'rgba(245, 158, 11, 0.12)',
      warningFg: '#fcd34d',
      danger: '#f87171',
      dangerSubtle: 'rgba(239, 68, 68, 0.12)',
      dangerFg: '#fca5a5',
      info: '#60a5fa',
      infoSubtle: 'rgba(59, 130, 246, 0.12)',
      infoFg: '#93c5fd',
    },
  },
  {
    key: 'deep-ocean',
    label: 'Deep Ocean',
    emoji: '🐋',
    description: '深海蓝暗色，沉稳专注',
    dark: true,
    primary: {
      50: '236 254 255',
      100: '207 250 254',
      200: '165 243 252',
      300: '103 232 249',
      400: '34 211 238',
      500: '6 182 212',
      600: '8 145 178',
      700: '14 116 144',
      800: '21 94 117',
      900: '22 78 99',
    },
    surface: {
      surface: '#0c1b2a',
      surfaceRaised: '#132f4c',
      surfaceMuted: '#1a3a5c',
      surfaceSunken: '#071318',
      fg: '#e3f2fd',
      fgSecondary: '#b0bec5',
      fgMuted: '#78909c',
      fgFaint: '#546e7a',
      edge: '#1a3a5c',
      edgeStrong: '#2c5282',
      success: '#4ade80',
      successSubtle: 'rgba(34, 197, 94, 0.12)',
      successFg: '#86efac',
      warning: '#facc15',
      warningSubtle: 'rgba(234, 179, 8, 0.12)',
      warningFg: '#fde047',
      danger: '#fb7185',
      dangerSubtle: 'rgba(244, 63, 94, 0.12)',
      dangerFg: '#fda4af',
      info: '#38bdf8',
      infoSubtle: 'rgba(14, 165, 233, 0.12)',
      infoFg: '#7dd3fc',
    },
  },
  {
    key: 'amoled',
    label: 'AMOLED Black',
    emoji: '⚫',
    description: '纯黑暗色，OLED 省电',
    dark: true,
    primary: {
      50: '243 244 246',
      100: '229 231 235',
      200: '209 213 219',
      300: '156 163 175',
      400: '107 114 128',
      500: '75 85 99',
      600: '55 65 81',
      700: '55 65 81',
      800: '31 41 55',
      900: '17 24 39',
    },
    surface: {
      surface: '#000000',
      surfaceRaised: '#0a0a0a',
      surfaceMuted: '#171717',
      surfaceSunken: '#000000',
      fg: '#fafafa',
      fgSecondary: '#d4d4d4',
      fgMuted: '#a3a3a3',
      fgFaint: '#737373',
      edge: '#262626',
      edgeStrong: '#404040',
      success: '#4ade80',
      successSubtle: 'rgba(34, 197, 94, 0.10)',
      successFg: '#86efac',
      warning: '#facc15',
      warningSubtle: 'rgba(234, 179, 8, 0.10)',
      warningFg: '#fde047',
      danger: '#f87171',
      dangerSubtle: 'rgba(239, 68, 68, 0.10)',
      dangerFg: '#fca5a5',
      info: '#60a5fa',
      infoSubtle: 'rgba(59, 130, 246, 0.10)',
      infoFg: '#93c5fd',
    },
  },
];

const STORAGE_KEY = 'greenhouse-theme';

/** Apply a theme by key to the document root */
export function applyTheme(themeKey: string): void {
  const theme = THEMES.find((t) => t.key === themeKey) || THEMES[0];
  const root = document.documentElement;

  // Set primary color variables
  for (const [shade, value] of Object.entries(theme.primary)) {
    root.style.setProperty(`--primary-${shade}`, value);
  }

  // Handle dark theme surface overrides
  if (theme.dark && theme.surface) {
    root.classList.add('dark-theme');
    const s = theme.surface;
    root.style.setProperty('--t-surface', s.surface);
    root.style.setProperty('--t-surface-raised', s.surfaceRaised);
    root.style.setProperty('--t-surface-muted', s.surfaceMuted);
    root.style.setProperty('--t-surface-sunken', s.surfaceSunken);
    root.style.setProperty('--t-fg', s.fg);
    root.style.setProperty('--t-fg-secondary', s.fgSecondary);
    root.style.setProperty('--t-fg-muted', s.fgMuted);
    root.style.setProperty('--t-fg-faint', s.fgFaint);
    root.style.setProperty('--t-edge', s.edge);
    root.style.setProperty('--t-edge-strong', s.edgeStrong);
    root.style.setProperty('--t-success', s.success);
    root.style.setProperty('--t-success-subtle', s.successSubtle);
    root.style.setProperty('--t-success-fg', s.successFg);
    root.style.setProperty('--t-warning', s.warning);
    root.style.setProperty('--t-warning-subtle', s.warningSubtle);
    root.style.setProperty('--t-warning-fg', s.warningFg);
    root.style.setProperty('--t-danger', s.danger);
    root.style.setProperty('--t-danger-subtle', s.dangerSubtle);
    root.style.setProperty('--t-danger-fg', s.dangerFg);
    root.style.setProperty('--t-destructive', '#ef4444');
    root.style.setProperty('--t-destructive-hover', '#f87171');
    root.style.setProperty('--t-star', '#fbbf24');
    root.style.setProperty('--t-star-hover', '#f59e0b');
    root.style.setProperty('--t-info', s.info);
    root.style.setProperty('--t-info-subtle', s.infoSubtle);
    root.style.setProperty('--t-info-fg', s.infoFg);
  } else {
    root.classList.remove('dark-theme');
    // Reset to light defaults (defined in app.css :root)
    root.style.setProperty('--t-surface', '#ffffff');
    root.style.setProperty('--t-surface-raised', '#ffffff');
    root.style.setProperty('--t-surface-muted', '#f3f4f6');
    root.style.setProperty('--t-surface-sunken', '#f9fafb');
    root.style.setProperty('--t-fg', '#111827');
    root.style.setProperty('--t-fg-secondary', '#4b5563');
    root.style.setProperty('--t-fg-muted', '#6b7280');
    root.style.setProperty('--t-fg-faint', '#9ca3af');
    root.style.setProperty('--t-edge', '#e5e7eb');
    root.style.setProperty('--t-edge-strong', '#d1d5db');
    root.style.setProperty('--t-success', '#059669');
    root.style.setProperty('--t-success-subtle', '#ecfdf5');
    root.style.setProperty('--t-success-fg', '#065f46');
    root.style.setProperty('--t-warning', '#d97706');
    root.style.setProperty('--t-warning-subtle', '#fffbeb');
    root.style.setProperty('--t-warning-fg', '#92400e');
    root.style.setProperty('--t-danger', '#dc2626');
    root.style.setProperty('--t-danger-subtle', '#fef2f2');
    root.style.setProperty('--t-danger-fg', '#991b1b');
    root.style.setProperty('--t-destructive', '#dc2626');
    root.style.setProperty('--t-destructive-hover', '#b91c1c');
    root.style.setProperty('--t-star', '#f59e0b');
    root.style.setProperty('--t-star-hover', '#d97706');
    root.style.setProperty('--t-info', '#2563eb');
    root.style.setProperty('--t-info-subtle', '#eff6ff');
    root.style.setProperty('--t-info-fg', '#1e40af');
  }

  localStorage.setItem(STORAGE_KEY, themeKey);
}

/** Get the currently active theme key */
export function getActiveTheme(): string {
  return localStorage.getItem(STORAGE_KEY) || 'teal';
}

/** Initialize theme from stored preference on app load */
export function initTheme(): void {
  const saved = getActiveTheme();
  applyTheme(saved);
  // Remove theme-loading class after first paint to enable smooth transitions
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.documentElement.classList.remove('theme-loading');
    });
  });
}

/** Get theme definition by key */
export function getThemeDef(key: string): ThemeDef | undefined {
  return THEMES.find((t) => t.key === key);
}
