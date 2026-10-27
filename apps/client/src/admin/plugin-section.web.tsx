/**
 * `/admin/p/<plugin>/<page>`: a plugin's Admin section, as its manifest declares it — a settings
 * form over the declared keys, or the plugin-owned native screen. A plugin that is off (or a page
 * that is not an Admin page) is not shown.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useStationManifest } from '../plugins/store';
import { adminScreens } from '../plugins/admin-screens.web';
import { localize } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { useT } from '../lib/i18n';
import { AdminPage, SectionState } from './kit.web';
import { SettingsForm } from './settings-form.web';

export default function PluginAdminSection() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const { plugin, page, view } = useLocalSearchParams<{ plugin: string; page: string; view?: string }>();
  const state = useStationManifest((s) => s.data);
  const status = useStationManifest((s) => s.status);
  const entry =
    state.kind === 'v2'
      ? state.manifest.plugins
          .find((p) => p.id === plugin)
          ?.pages.find((p) => p.id === page && 'parent' in p && p.parent === 'administration')
      : undefined;
  const title = entry ? localize(entry.title, lang) : t('admin.title');
  if (entry?.kind === 'settings-form')
    return (
      <AdminPage title={title} testID="admin-plugin-settings">
        <SettingsForm key={`${plugin}/${page}`} keys={entry.settings} />
      </AdminPage>
    );
  const Screen = entry?.kind === 'native' ? adminScreens[entry.screen]?.component : undefined;
  if (Screen) return <Screen key={`${plugin}/${page}`} plugin={plugin} page={page} title={title} view={view} />;
  return (
    <AdminPage title={title}>
      <SectionState
        loading={status === 'loading' || status === 'idle'}
        icon="apps"
        title={t('admin.missing')}
        message={t('admin.missingHint')}
      />
    </AdminPage>
  );
}
