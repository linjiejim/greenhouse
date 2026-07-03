/**
 * Greenhouse launcher widget (v1) — static home-screen shortcuts, no data
 * pipeline (no App Group yet). Colors mirror src/theme.ts (Greenhouse Teal
 * light/dark); dark tint/border values are the rgba tokens pre-composited
 * over the dark surface (#1e293b) since colorsets need opaque hexes.
 */

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'GreenhouseWidget',
  displayName: 'Greenhouse',
  bundleIdentifier: '.widget',
  deploymentTarget: '17.0',
  entitlements: {
    // Same App Group as the host app (app.json ios.entitlements) — the
    // snapshot handoff (modules/widget-bridge) depends on it.
    'com.apple.security.application-groups': ['group.app.greenhouse.mobile'],
  },
  colors: {
    // System-recognized: widget editing tint + default background.
    $accent: { color: '#0d9488', darkColor: '#5eead4' },
    $widgetBackground: { color: '#ffffff', darkColor: '#1e293b' },
    // App palette (theme.ts light/dark).
    WidgetFg: { color: '#111827', darkColor: '#f8fafc' },
    WidgetMuted: { color: '#6b7280', darkColor: '#94a3b8' },
    OnAccent: { color: '#ffffff', darkColor: '#042f2e' },
    AccentTint: { color: '#f0fdfa', darkColor: '#1d3a48' },
    AccentBorder: { color: '#99f6e4', darkColor: '#1c4d56' },
    StatusSuccess: { color: '#059669', darkColor: '#34d399' },
    StatusDanger: { color: '#dc2626', darkColor: '#f87171' },
  },
  images: {
    sprouty: './sprouty-idle.png',
    sproutySleep: './sprouty-sleep.png',
  },
};
