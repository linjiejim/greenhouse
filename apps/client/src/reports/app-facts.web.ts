/** What a report says about this build in a browser or the macOS shell: platform, a coarse browser and OS, the app version. */

import Constants from 'expo-constants';
import { CLIENT_CHANNEL } from '../desktop/channel';
import type { ReportContext } from './model';

/** "Chrome 141 · macOS" from the user agent: a browser family and major version, an OS family. */
function browserLine(agent: string): string | null {
  // Edge and Chrome also say Safari, Edge also says Chrome: the most specific token first
  const browser = ['Edg', 'Firefox', 'Chrome', 'Version']
    .map((token) => new RegExp(`\\b(${token})/(\\d+)`).exec(agent))
    .find(Boolean);
  const name = browser ? (({ Edg: 'Edge', Version: 'Safari' }) as Record<string, string>)[browser[1]!] ?? browser[1] : null;
  const os = /Mac OS X|Macintosh/.test(agent)
    ? 'macOS'
    : /Windows/.test(agent)
      ? 'Windows'
      : /Android/.test(agent)
        ? 'Android'
        : /iPhone|iPad/.test(agent)
          ? 'iOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : null;
  return [name && `${name} ${browser![2]}`, os].filter(Boolean).join(' · ') || null;
}

export function appFacts(): Pick<ReportContext, 'platform' | 'os_version' | 'app_version' | 'app_build'> {
  return {
    platform: CLIENT_CHANNEL === 'desktop' ? 'desktop' : 'web',
    os_version: typeof navigator === 'undefined' ? null : browserLine(navigator.userAgent),
    app_version: Constants.expoConfig?.version ?? null,
    app_build: null,
  };
}
