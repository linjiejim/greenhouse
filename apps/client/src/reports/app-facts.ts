/** What a report says about this build on a phone: platform, OS version, app version and build (with the OTA update it runs). */

import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
import type { ReportContext } from './model';

export function appFacts(): Pick<ReportContext, 'platform' | 'os_version' | 'app_version' | 'app_build'> {
  const build =
    Platform.OS === 'ios'
      ? Constants.platform?.ios?.buildNumber
      : Constants.expoConfig?.android?.versionCode?.toString();
  // a JS error belongs to the bundle that threw it: an OTA update names its own
  const update = Updates.isEnabled && !Updates.isEmbeddedLaunch && Updates.updateId ? Updates.updateId.slice(0, 8) : null;
  return {
    platform: Platform.OS === 'android' ? 'android' : 'ios',
    os_version: String(Platform.Version),
    app_version: Constants.expoConfig?.version ?? null,
    app_build: [build, update && `ota ${update}`].filter(Boolean).join(' ') || null,
  };
}
