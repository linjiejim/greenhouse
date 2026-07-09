// Keep the native fingerprint stable across release-please version bumps:
// `expo.version` in app.json is synced to the product version on every release
// (release-please-config.json `extra-files`), and without this skip each bump
// would change the fingerprint → a full EAS build + TestFlight submit instead
// of an OTA update. The version string itself never affects native
// compatibility, so skipping it is safe for `runtimeVersion.policy:
// "fingerprint"`. String names are resolved by @expo/fingerprint's config
// loader (no require needed — the package isn't hoisted by pnpm).
// `PackageJsonAndroidAndIosScriptsIfNotContainRun` restores the library
// default, which setting `sourceSkips` would otherwise override.
/** @type {import('@expo/fingerprint').Config} */
module.exports = {
  sourceSkips: [
    'ExpoConfigVersions',
    'PackageJsonAndroidAndIosScriptsIfNotContainRun',
  ],
};
