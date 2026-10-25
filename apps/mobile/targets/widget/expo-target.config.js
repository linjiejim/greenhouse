/**
 * Home-screen widgets "我的任务" (the next three tasks due) and "最近文档" (the three documents
 * opened last). They read the snapshot the app writes into the App Group (src/widget/model.ts,
 * modules/widget-bridge) — titles, dates and links only, never a token — and open the item in the
 * app on tap.
 */

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'GreenhouseWidget',
  displayName: 'Greenhouse',
  bundleIdentifier: '.widget',
  deploymentTarget: '17.0',
  entitlements: {
    // Same App Group as the host app (app.json ios.entitlements): the snapshot lives in it.
    'com.apple.security.application-groups': ['group.app.greenhouse.mobile'],
  },
  // The key shape is `{ light, dark }` (the plugin README's `{ color, darkColor }` yields empty colorsets).
  colors: {
    $accent: { light: '#235D4D', dark: '#B1D2BF' },
    $widgetBackground: { light: '#FFFFFF', dark: '#1C1C1E' },
  },
};
