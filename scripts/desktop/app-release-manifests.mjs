/**
 * Pure manifest assembly for a shell (full app) release — no filesystem access.
 *
 * `make-app-release.mjs` collects one platform's artifacts into a fragment;
 * `merge-app-release.mjs` feeds every fragment through this to produce the final
 * documents. Unit tests exercise the same functions directly
 * (tests/desktop-app-release.test.ts). Two documents come out of one input so
 * they can never disagree:
 *
 *   latest.json     tauri-plugin-updater protocol — drives in-app shell updates
 *   downloads.json  our own index — drives the web settings download card and
 *                   the publish workflow's "is the server already current?" check
 *
 * Platform naming follows the updater's convention (`darwin-aarch64`,
 * `windows-x86_64`). On Windows the updater payload IS the signed NSIS installer
 * (Tauri v2 `createUpdaterArtifacts`), so both documents point at the same
 * `-setup.exe`; on macOS the updater payload (`.app.tar.gz`) and the browser
 * download (`.dmg`) are distinct files.
 */

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Where the artifacts of one release live when the update source hosts them
 * itself: `<update base>/<channel>/app`. A pipeline that parks the big files
 * elsewhere (a GitHub Release, object storage) passes that location as
 * `artifactBaseUrl` instead — the manifests carry absolute URLs either way, and
 * the shell only downloads from origins its build allowed.
 */
export function artifactBaseFor(updateBaseUrl, channel) {
  return `${String(updateBaseUrl).replace(/\/+$/, '')}/${channel}/app`;
}

export const CHANNELS = ['stable', 'beta'];

const PLATFORM_LABELS = {
  'darwin-aarch64': 'macOS (Apple Silicon)',
  'darwin-x86_64': 'macOS (Intel)',
  'windows-x86_64': 'Windows (x64)',
};

/** `Greenhouse-0.38.0-aarch64` — version + arch in the name so releases never collide. */
export function appFileStem(version, arch) {
  return `Greenhouse-${version}-${arch}`;
}

/**
 * Per-platform artifact names, derived from the platform key alone so the
 * collector (make) and the assembler (merge) can never disagree about them.
 *
 * @param {string} platformKey  e.g. `darwin-aarch64` | `windows-x86_64`
 * @param {string} version
 */
export function platformArtifactNames(platformKey, version) {
  const [os, arch] = splitPlatformKey(platformKey);
  const stem = appFileStem(version, arch);
  if (os === 'darwin') {
    return {
      installer: `${stem}.dmg`,
      updater: `${stem}.app.tar.gz`,
      updaterSigFile: `${stem}.app.tar.gz.sig`,
    };
  }
  // One file plays both roles: the signed NSIS installer is the updater payload.
  const installer = `${stem}-setup.exe`;
  return { installer, updater: installer, updaterSigFile: `${installer}.sig` };
}

function splitPlatformKey(platformKey) {
  const label = PLATFORM_LABELS[platformKey];
  if (!label) {
    throw new Error(
      `unsupported platform ${JSON.stringify(platformKey)} — known: ${Object.keys(PLATFORM_LABELS).join(', ')}`,
    );
  }
  const dash = platformKey.indexOf('-');
  return [platformKey.slice(0, dash), platformKey.slice(dash + 1)];
}

/**
 * Build both release manifests for a multi-platform shell release.
 *
 * @param {{
 *   version: string;          // product version (root package.json)
 *   nativeApiVersion: string; // shell compatibility line (apps/desktop/package.json)
 *   channel: string;          // stable | beta
 *   artifactBaseUrl: string;  // absolute URL the artifacts are served under
 *   releasedAt: string;       // ISO timestamp
 *   notes: string;            // one-line human summary
 *   platforms: Array<{
 *     platformKey: string;        // darwin-aarch64 | windows-x86_64 | …
 *     updaterSig: string;         // contents of the minisign signature file
 *     installerSizeBytes: number; // size of the browser-download artifact
 *   }>;
 * }} input
 */
export function buildAppReleaseManifests(input) {
  const { version, nativeApiVersion, channel, artifactBaseUrl, releasedAt, notes, platforms } = input;

  if (!SEMVER.test(version ?? '')) throw new Error(`version must be semver, got ${JSON.stringify(version)}`);
  if (!SEMVER.test(nativeApiVersion ?? '')) {
    throw new Error(`nativeApiVersion must be semver, got ${JSON.stringify(nativeApiVersion)}`);
  }
  if (!CHANNELS.includes(channel)) throw new Error(`channel must be one of ${CHANNELS.join('/')}, got ${channel}`);
  if (!/^https?:\/\/\S+$/.test(artifactBaseUrl ?? '')) {
    throw new Error(`artifactBaseUrl must be an http(s) URL, got ${JSON.stringify(artifactBaseUrl)}`);
  }
  if (Number.isNaN(Date.parse(releasedAt ?? ''))) {
    throw new Error(`releasedAt must be an ISO timestamp, got ${JSON.stringify(releasedAt)}`);
  }
  if (!Array.isArray(platforms) || platforms.length === 0) {
    throw new Error('platforms must be a non-empty array');
  }

  const baseUrl = artifactBaseUrl.replace(/\/+$/, '');
  const latestPlatforms = {};
  const downloadPlatforms = {};

  for (const platform of platforms) {
    const { platformKey, updaterSig, installerSizeBytes } = platform;
    if (latestPlatforms[platformKey]) throw new Error(`duplicate platform ${platformKey}`);
    const names = platformArtifactNames(platformKey, version); // rejects unknown keys
    const label = PLATFORM_LABELS[platformKey];
    const signature = (updaterSig ?? '').trim();
    if (!signature) {
      throw new Error(`updaterSig for ${platformKey} is empty — was the build signed (TAURI_SIGNING_PRIVATE_KEY)?`);
    }
    if (!Number.isInteger(installerSizeBytes) || installerSizeBytes <= 0) {
      throw new Error(`installerSizeBytes for ${platformKey} must be a positive integer, got ${installerSizeBytes}`);
    }

    latestPlatforms[platformKey] = { signature, url: `${baseUrl}/${names.updater}` };
    downloadPlatforms[platformKey] = {
      label,
      url: `${baseUrl}/${names.installer}`,
      sizeBytes: installerSizeBytes,
    };
  }

  return {
    latest: {
      version,
      notes,
      pub_date: releasedAt,
      platforms: latestPlatforms,
    },
    downloads: {
      schemaVersion: 1,
      version,
      nativeApiVersion,
      releasedAt,
      platforms: downloadPlatforms,
    },
  };
}
