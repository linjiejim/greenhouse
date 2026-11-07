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
import { WIDE_MIN } from '../shell/wide-model';
import { useEmbedBack } from './embed-back';
import { useT } from '../lib/i18n';
import { Icon } from '../ui/core.web';

/** The wide header's Back: only while an embed shows a sub-view it can leave (greenhouse:back). */
function EmbedBack({ backKey }: { backKey: string }) {
  const request = useEmbedBack(backKey),
    t = useT(),
    { hex: c } = useTheme();
  if (!request) return null;
  return (
    <button
      data-testid="embed-back"
      onClick={request}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        height: 32,
        padding: '0 10px 0 6px',
        marginLeft: 8,
        border: 0,
        borderRadius: 8,
        background: 'transparent',
        color: c.accentText,
        font: 'inherit',
        fontSize: 15,
        cursor: 'pointer',
      }}
    >
      <span aria-hidden style={{ display: 'flex', transform: 'rotate(180deg)' }}>
        <Icon name="chevR" size={14} weight="semibold" color={c.accentText} />
      </span>
      {t('client.back')}
    </button>
  );
}
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
      {width >= WIDE_MIN ? (
        // A plugin page is a place in the wide shell: no back button, the main area's own surface —
        // except an embed's Back while it shows a sub-view.
        <Stack.Screen
          options={{
            headerLeft: () => <EmbedBack backKey={`${plugin}:${page}`} />,
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
