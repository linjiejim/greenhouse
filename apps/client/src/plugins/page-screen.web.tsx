import React from 'react';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { pluginSectionHref } from '../admin/sections';
import { useWindowDimensions } from 'react-native';
import { useTheme } from '../theme';
import Host from './page-host';
import { useStationManifest } from './store';
import { localize } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { PlaceSecondary } from '../shell/place-secondary.web';
import { PlaceSidebar, PlaceRow } from '../ui/place.web';
import { pluginHref } from './navigation';
import { pluginIcon } from './icons';
export default function PluginPageScreen(props: { detail?: boolean }) {
  const { plugin, page } = useLocalSearchParams<{ plugin: string; page: string }>(),
    state = useStationManifest((s) => s.data),
    lang = usePrefs((s) => s.lang),
    router = useRouter(),
    { width } = useWindowDimensions(),
    { hex } = useTheme(),
    [query, setQuery] = React.useState('');
  const entry = state.kind === 'v2' ? state.manifest.plugins.find((p) => p.id === plugin) : undefined;
  const target = entry?.pages.find((p) => p.id === page);
  // An Admin section opens in the Admin place, not as an app page.
  if (!props.detail && target && 'parent' in target && target.parent === 'administration')
    return <Redirect href={pluginSectionHref(entry!.id, target.id) as never} />;
  return (
    <>
      {width >= 760 ? (
        // A plugin page is a place in the wide shell: no back button, the main area's own surface.
        <Stack.Screen
          options={{
            headerLeft: () => null,
            headerStyle: { backgroundColor: hex.background },
            headerShadowVisible: true,
          }}
        />
      ) : null}
      {!props.detail && entry && entry.nav.length > 1 ? (
        <PlaceSecondary>
          <PlaceSidebar title={localize(entry.name, lang)} query={query} onQuery={setQuery}>
            <div data-place-list>
              {entry.nav
                .filter((n) => !query || localize(n.label, lang).includes(query))
                .map((nav) => (
                  <PlaceRow
                    key={nav.id}
                    title={localize(nav.label, lang)}
                    icon={pluginIcon(nav, entry.pages.find((p) => p.id === nav.page))}
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
