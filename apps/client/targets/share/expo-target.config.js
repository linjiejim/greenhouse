/**
 * The share extension "存到 Greenhouse": share photos, videos and files from any app into Files
 * (档案库) on the station the app is signed in to. It reads the station and a short-lived access
 * token the app keeps in the App Group keychain (src/share/session.ts) — never the refresh token —
 * and uploads with the same three steps as the app (init → bytes → complete).
 */

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'share',
  name: 'GreenhouseShare',
  displayName: '存到 Greenhouse',
  bundleIdentifier: '.share',
  deploymentTarget: '17.0',
  entitlements: {
    // Same App Group as the host app (app.json ios.entitlements): the keychain item lives in it
    // (an App Group doubles as a keychain access group).
    'com.apple.security.application-groups': ['group.app.greenhouse.mobile'],
  },
  colors: {
    $accent: { light: '#235D4D', dark: '#B1D2BF' },
  },
};
