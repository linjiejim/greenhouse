import React from 'react';
import { Text, View } from 'react-native';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useStationManifest } from './store';
import { fallbackUrl } from './manifest';
import { nativeScreens } from './native-registry';
import { localize } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { getApiBase } from '../store/stations';
import { openLink } from '../lib/links';
import { useT } from '../lib/i18n';
import { Screen } from '../ui/screen';
import { NativeButton } from '../ui/button';
import { space, typo, useTheme } from '../theme';
import { EntityList, EntityDetail } from './entity-screen';
import { SettingsForm } from './settings-screen';
import { EmbedScreen } from './embed-screen';
import { ResourceScreen } from './resource-screen';
import { safeEndpoint } from './surface-model';
export default function PluginPageScreen({ detail = false }: { detail?: boolean }) {
  const {
    plugin,
    page,
    id,
    entity: entityId,
  } = useLocalSearchParams<{ plugin: string; page: string; id?: string; entity?: string }>();
  const state = useStationManifest((s) => s.data),
    lang = usePrefs((s) => s.lang),
    t = useT(),
    { hex: c } = useTheme();
  const manifest = state.kind === 'v2' ? state.manifest.plugins.find((p) => p.id === plugin) : undefined;
  const entry = manifest?.pages.find((p) => p.id === page);
  const title = entry ? localize(entry.title, lang) : t('client.pluginUnavailable');
  if (entry && manifest) {
    const entity = manifest.entities?.find(
      (e) => e.id === (entityId ?? ('entity' in entry ? entry.entity : undefined)),
    );
    if (detail && id && entity && safeEndpoint(entity.endpoint))
      return <EntityDetail key={`${plugin}:${entity.id}:${id}`} entity={entity} id={id} />;
    if (entry.kind === 'native') {
      const native = nativeScreens[entry.screen];
      if (native?.route) return <Redirect href={native.route as never} />;
      if (native?.endpoint) return <ResourceScreen key={entry.screen} entry={native} title={title} />;
    }
    if (entry.kind === 'entity-list' && entity && safeEndpoint(entity.endpoint))
      return (
        <EntityList
          key={`${plugin}:${page}`}
          entity={entity}
          page={entry}
          plugin={plugin}
          detailPage={manifest.pages.find((p) => p.kind === 'entity-detail' && p.entity === entity.id)?.id ?? page}
        />
      );
    if (entry.kind === 'entity-detail' && entity && id && safeEndpoint(entity.endpoint))
      return <EntityDetail entity={entity} id={id} />;
    if (entry.kind === 'settings-form')
      return <SettingsForm key={`${plugin}:${page}`} keys={entry.settings} title={title} />;
    if (entry.kind === 'embed')
      return <EmbedScreen key={`${plugin}:${page}`} plugin={plugin} page={entry} title={title} />;
  }
  const url = entry ? fallbackUrl(entry, getApiBase()) : null;
  return (
    <>
      <Screen title={title} />
      <View style={{ padding: space.xxl, gap: space.lg }}>
        <Text style={{ ...typo.body, color: c.label }}>
          {entry ? t('client.unsupportedPage') : t('client.pluginUnavailable')}
        </Text>
        {url ? <NativeButton label={t('client.openBrowser')} icon="open" onPress={() => void openLink(url)} /> : null}
      </View>
    </>
  );
}
