import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Host from './page-host';
import { useStationManifest } from './store';
import { localize } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { PlaceSecondary } from '../shell/place-secondary.web';
import { PlaceSidebar, PlaceRow } from '../ui/place.web';
import { pluginHref } from './navigation';
export default function PluginPageScreen(props: { detail?: boolean }) {
  const { plugin, page } = useLocalSearchParams<{ plugin: string; page: string }>(),
    state = useStationManifest((s) => s.data),
    lang = usePrefs((s) => s.lang),
    router = useRouter(),
    [query, setQuery] = React.useState('');
  const entry = state.kind === 'v2' ? state.manifest.plugins.find((p) => p.id === plugin) : undefined;
  return (
    <>
      {!props.detail && entry ? (
        <PlaceSecondary>
          <PlaceSidebar title={localize(entry.name, lang)} query={query} onQuery={setQuery}>
            <div data-place-list>
              {entry.nav
                .filter((n) => !query || localize(n.label, lang).includes(query))
                .map((nav) => (
                  <PlaceRow
                    key={nav.id}
                    title={localize(nav.label, lang)}
                    selected={page === nav.page}
                    onOpen={() => {
                      const target = entry.pages.find((p) => p.id === nav.page);
                      if (target) router.navigate(pluginHref(entry.id, target) as never);
                    }}
                  />
                ))}
            </div>
          </PlaceSidebar>
        </PlaceSecondary>
      ) : null}
      <Host {...props} />
    </>
  );
}
