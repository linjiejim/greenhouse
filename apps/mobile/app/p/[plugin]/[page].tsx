import React from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { fallbackUrl } from '../../../src/plugins/manifest';
import { useStationManifest } from '../../../src/plugins/store';
import { localize } from '../../../src/shared/plugins';
import { usePrefs } from '../../../src/store/prefs';
import { getApiBase } from '../../../src/store/stations';
import { openLink } from '../../../src/lib/links';
import { NativeButton } from '../../../src/ui/button';
import { Screen } from '../../../src/ui/screen';
import { useT } from '../../../src/lib/i18n';
import { space, typo, useTheme } from '../../../src/theme';
export default function PluginPage() {
  const { plugin, page } = useLocalSearchParams<{ plugin: string; page: string }>();
  const state = useStationManifest((s) => s.data);
  const lang = usePrefs((s) => s.lang);
  const t = useT();
  const { hex: c } = useTheme();
  const entry =
    state.kind === 'v2'
      ? state.manifest.plugins.find((p) => p.id === plugin)?.pages.find((p) => p.id === page)
      : undefined;
  const url = entry ? fallbackUrl(entry, getApiBase()) : null;
  return (
    <>
      <Screen title={entry ? localize(entry.title, lang) : t('client.pluginUnavailable')} />
      <View style={{ padding: space.xxl, gap: space.lg }}>
        <Text style={{ ...typo.body, color: c.label }}>
          {entry ? t('client.unsupportedPage') : t('client.pluginUnavailable')}
        </Text>
        {url ? <NativeButton label={t('client.openBrowser')} icon="open" onPress={() => void openLink(url)} /> : null}
      </View>
    </>
  );
}
