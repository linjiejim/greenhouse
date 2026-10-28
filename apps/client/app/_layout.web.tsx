// first: errors are caught from the first module on (src/reports)
import { useClientReports } from '../src/reports/client-reports';
import '../src/plugins/store';
import { clearHandoffs } from '../src/lib/handoff';
/**
 * Root layout — bootstraps auth + prefs, applies the appearance, gates routes, and declares the
 * app's native navigation map:
 *
 *  - `(drawer)`          the sidebar and its places: 首页 · 知识库 · 云盘 · 项目 · 定时任务, each with its own
 *                        stack; home's holds search and the conversation page (`/chat`, the only
 *                        object that is not a sheet); a drawer on a phone, a column on an iPad
 *  - `sheet/*`           every other object, opened by openObject (src/shell/open-object.ts) as a
 *                        form sheet; sheets stack on sheets up to three deep
 *  - `me`                「我」: account, station, text size, My Agents, settings (page sheet with
 *                        its own stack)
 *  - `notifications`, `conversations`, `move`, `task-form`, `tables/new-record`, `sheets/stations`, `sheets/station-add`  sheets
 *  - `peek/*`, `table`   full-screen viewers for rich blocks (html preview, diagram, table)
 *  - `login`             full screen, shown when signed out
 *  - `activate`, `oauth-consent`, `connectors/oauth-finish`, `bindings`  entry pages server links
 *                        open (src/shared/client-routes.ts); they stand alone, without the rail
 *
 * Presentation (push / sheet / modal) is decided here, because it must be known before a screen
 * mounts; titles and toolbar buttons are declared by each screen with `Stack.Screen` /
 * `Stack.Toolbar`.
 *
 * Deep links and push taps may land on any route at cold start: `initialRouteName` anchors the
 * root stack on the tabs, so a page / sheet / modal always has home underneath.
 *
 * Auth gate: signed out on any route but /login, /activate and the stations sheet → everything
 * above the root is dismissed, then /login replaces it (the route is kept and opened after
 * sign-in); signed in on /login, or just activated on /activate → home. A station
 * older than this app's API level (src/api/bootstrap.ts) shows why — the station needs updating —
 * with the way to another station, never a white screen.
 *
 * `usePushBridge` runs the push side (src/push): registration, taps, banners, badge.
 */

import 'react-native-gesture-handler';
import '../src/shell/client.css';
import { ClientShell } from '../src/desktop/client-shell';
import { captureEntry, takeActivated } from '../src/login/entry-links';

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Stack, usePathname, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '../src/store/auth';
import { forgetOfflineCopies } from '../src/store/notifications';
import { usePrefs } from '../src/store/prefs';
import { useStations } from '../src/store/stations';
import { StartupContent, waitsForHome } from '../src/startup/content';
import { StartupContext } from '../src/startup/context';
import { setOnUnauthorized } from '../src/api/client';
import { useAccountLanguage } from '../src/settings/account-language';
import { useAccountTextSize } from '../src/settings/text-size';
import { useOutboxFlush } from '../src/store/outbox';

import { useApplyAppearance, useTheme } from '../src/theme';
import { Splash } from '../src/ui/splash';
import { LoadingState } from '../src/ui/loading-state';
import { DialogHost } from '../src/ui/dialogs';
import { MenuHost } from '../src/ui/menu';
import { ToastHost } from '../src/ui/toast';
import { useT } from '../src/lib/i18n';
import { MismatchScreen } from '../src/shell/mismatch';
import { detailScreen, modalScreen, sheetScreen, stackDefaults } from '../src/ui/nav';
import { sheetEdgeLayout } from '../src/ui/sheet-edge';
import nunitoRegular from '../assets/fonts/Nunito-Regular.ttf';
import nunitoMedium from '../assets/fonts/Nunito-Medium.ttf';
import nunitoSemiBold from '../assets/fonts/Nunito-SemiBold.ttf';
import nunitoBold from '../assets/fonts/Nunito-Bold.ttf';

/** Routes a signed-out member may be on: the login page, the stations sheet it opens, account activation. */
const SIGNED_OUT_ROUTES = new Set(['login', 'sheets/stations', 'sheets/station-add', 'activate']);

const pathOf = (route: string) => route.split(/[?#]/, 1)[0]!;

// Before routing: an entry route's secret fragment is held back (src/login/entry-links.ts), and the
// route is kept to open after sign-in (or right away, when it is open to everyone and the router
// started elsewhere).
let pendingRoute: string | null = null;
// The router parsed the address before this module ran; it keeps the fragment as the `#` param.
let fragmentToForget = false;
/** A route open to everyone that the gate sent the router to and that has not arrived yet. */
let opening: string | null = null;
if (typeof window !== 'undefined') {
  const { pathname, search, hash } = window.location;
  const current = pathname + search + hash;
  const visible = captureEntry(current);
  if (visible !== current) {
    window.history.replaceState(null, '', visible);
    fragmentToForget = hash !== '';
  }
  const target = visible.split('#', 1)[0]!;
  if (pathOf(target) !== '/') pendingRoute = target;
}
let handoffIdentity = '';
const followHandoffs = () => {
  const next = `${useStations.getState().activeId ?? ''}:${useAuth.getState().user?.id ?? ''}`;
  if (next !== handoffIdentity) {
    handoffIdentity = next;
    Keyboard.dismiss();
    clearHandoffs();
  }
};
useAuth.subscribe(followHandoffs);
useStations.subscribe(followHandoffs);

export const unstable_settings = { initialRouteName: '(drawer)' };

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Nunito: nunitoRegular,
    'Nunito-Medium': nunitoMedium,
    'Nunito-SemiBold': nunitoSemiBold,
    'Nunito-Bold': nunitoBold,
  });
  useApplyAppearance();
  const { colors: c, hex, isDark } = useTheme();
  const t = useT();
  const bootstrap = useAuth((s) => s.bootstrap);
  const loading = useAuth((s) => s.loading);
  const startupError = useAuth((s) => s.startupError);
  const mismatch = useAuth((s) => s.mismatch);
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const router = useRouter();
  const segments = useSegments();
  const pathname = usePathname();

  const hydratePrefs = usePrefs((s) => s.hydrate);

  useEffect(() => {
    bootstrap();
    void hydratePrefs();
    setOnUnauthorized(() => {
      // the server ended this session: its member's offline copies go with it
      const stationId = useStations.getState().activeId;
      const memberId = useAuth.getState().user?.id;
      if (stationId && memberId) forgetOfflineCopies(stationId, memberId);
      logout();
    });
  }, [bootstrap, hydratePrefs, logout]);

  // Do not gate mounting on fonts or page data: mounting is what starts the
  // first request, and the same screen keeps its result when the cover leaves.
  const routesReady = !loading;
  const ready = routesReady && (fontsLoaded || !!fontError || !!startupError);
  const [splashGone, setSplashGone] = useState(false);
  const stationId = useStations((s) => s.activeId);
  const userId = user?.id;
  // A bootstrap / identity transition cannot inherit another member's readiness.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- these are the lifetime keys of the launch scope
  const content = useMemo(() => new StartupContent(), [loading, stationId, userId]);
  const contentReady = useSyncExternalStore(content.subscribe, content.getSnapshot, content.getSnapshot);
  const startup = useMemo(
    () => ({ content, covered: !splashGone && !startupError }),
    [content, splashGone, startupError],
  );

  // Redirect based on auth state once bootstrap resolves.
  useEffect(() => {
    if (!routesReady || mismatch) return;
    if (fragmentToForget) {
      // a held secret (or an old classic route) must not come back into the address bar
      fragmentToForget = false;
      router.setParams({ '#': '' } as never);
    }
    // the router is on its way to a route open to everyone: let it arrive first
    if (opening && pathOf(opening) !== pathname) return;
    opening = null;
    const inAuthGroup = segments[0] === 'login';
    // a finished activation signs the new member in on its own page; then they go home
    const activated = segments[0] === 'activate' && !!user && takeActivated();
    // A pending route already on screen is not opened again: that would remount it, and an entry
    // page would lose the parameters it took on its first mount.
    const onScreen = !!pendingRoute && pathOf(pendingRoute) === pathname;
    if (!user && pendingRoute && SIGNED_OUT_ROUTES.has(pathOf(pendingRoute).slice(1))) {
      const target = pendingRoute;
      pendingRoute = null;
      if (!onScreen) {
        opening = target;
        router.replace(target as never);
      }
    } else if (!user && !SIGNED_OUT_ROUTES.has(segments.join('/'))) {
      // drop pages / sheets stacked over home first, or they'd stay mounted
      // under the login page (and come back after the next sign-in)
      if (router.canDismiss()) router.dismissAll();
      router.replace('/login');
    } else if (user && (inAuthGroup || pendingRoute || activated)) {
      const target = pendingRoute;
      pendingRoute = null;
      if (!onScreen || inAuthGroup || activated) router.replace((target || '/') as never);
    }
  }, [routesReady, mismatch, user, segments, pathname, router]);

  // The app speaks the account's language (src/settings/account-language.ts) and reads at its
  // text size (src/settings/text-size.ts); messages written offline go once the station answers.
  useAccountLanguage();
  useAccountTextSize();
  useOutboxFlush();
  useClientReports();

  // Pushes (src/push): this phone's registration per signed-in station, opening a tapped
  // notification once the routes are up (switching station first when it came from
  // another), clearing banners and keeping the app icon badge on the unread count.

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          {Platform.OS === 'android' ? <StatusBar style={isDark ? 'light' : 'dark'} /> : null}
          <StartupContext.Provider value={startup}>
            {!routesReady ? (
              <View style={{ flex: 1, backgroundColor: c.background }}>
                <LoadingState />
              </View>
            ) : mismatch ? (
              <MismatchScreen />
            ) : (
              <ClientShell>
                <Stack
                  screenOptions={{ ...stackDefaults(c, hex, isDark), headerShown: false }}
                  screenLayout={sheetEdgeLayout}
                >
                  {/* the tabs are the stack's root: never popped by the back gesture */}
                  <Stack.Screen name="(drawer)" options={{ title: t('nav.home'), gestureEnabled: false }} />
                  <Stack.Screen name="login" options={{ animation: 'fade', gestureEnabled: false }} />

                  {/* ── entry pages a browser lands on from mail, OAuth and IM (src/login/entry-links.ts) ── */}
                  <Stack.Screen name="activate" options={{ animation: 'fade', gestureEnabled: false }} />
                  <Stack.Screen name="oauth-consent" options={{ animation: 'fade', gestureEnabled: false }} />
                  <Stack.Screen name="connectors/oauth-finish" options={{ animation: 'fade', gestureEnabled: false }} />
                  <Stack.Screen name="bindings" options={{ animation: 'fade', gestureEnabled: false }} />

                  {/* ── object sheets (openObject): documents and files read full height ── */}
                  <Stack.Screen name="sheet/conversation" options={sheetScreen([1], { header: true })} />
                  <Stack.Screen name="sheet/plugin" options={sheetScreen([1], { header: true })} />
                  <Stack.Screen name="sheet/doc" options={sheetScreen([1], { header: true })} />
                  <Stack.Screen name="sheet/file" options={sheetScreen([1], { header: true })} />
                  <Stack.Screen name="sheet/folder" options={sheetScreen([0.75, 1], { header: true })} />
                  <Stack.Screen name="sheet/project" options={sheetScreen([1], { header: true })} />
                  <Stack.Screen name="sheet/task" options={sheetScreen([0.6, 1], { header: true })} />
                  <Stack.Screen name="sheet/record" options={sheetScreen([0.6, 1], { header: true })} />
                  <Stack.Screen name="sheet/notification" options={sheetScreen([0.6, 1], { header: true })} />
                  <Stack.Screen name="sheet/run" options={sheetScreen([0.6, 1], { header: true })} />
                  <Stack.Screen name="sheet/write" options={sheetScreen([0.6, 1], { header: true })} />
                  <Stack.Screen name="sheet/steps" options={sheetScreen([0.6, 1], { header: true })} />
                  <Stack.Screen name="sheet/automation" options={sheetScreen([0.6, 1], { header: true })} />

                  {/* ── home's sheets and pickers ── */}
                  <Stack.Screen name="notifications" options={sheetScreen([0.7, 1], { header: true })} />
                  <Stack.Screen name="conversations" options={sheetScreen([1], { header: true })} />
                  <Stack.Screen name="move" options={sheetScreen([0.7, 1], { header: true })} />
                  <Stack.Screen name="doc-new" options={sheetScreen([1], { header: true })} />
                  <Stack.Screen name="task-form" options={sheetScreen([1], { header: true })} />
                  <Stack.Screen name="sheets/stations" options={sheetScreen([0.6, 1], { header: true })} />
                  <Stack.Screen name="sheets/station-add" options={sheetScreen([0.5, 1], { header: true })} />
                  <Stack.Screen name="sheets/feedback" options={sheetScreen([0.7, 1], { header: true })} />
                  <Stack.Screen name="tables/new-record" options={sheetScreen([1], { header: true })} />

                  {/* ── full-screen viewers of rich blocks ── */}
                  <Stack.Screen name="peek/html" options={{ ...detailScreen(c), presentation: 'fullScreenModal' }} />
                  <Stack.Screen name="peek/diagram" options={{ ...detailScreen(c), presentation: 'modal' }} />
                  <Stack.Screen name="table" options={{ ...detailScreen(c), presentation: 'modal' }} />

                  {/* ── 「我」: a page sheet with its own stack ── */}
                  <Stack.Screen name="me" options={modalScreen()} />
                </Stack>
              </ClientShell>
            )}
          </StartupContext.Provider>
          {/* over the app until its mark is built and the app is ready, then it fades away */}
          {splashGone || startupError ? null : (
            <Splash
              ready={ready}
              contentReady={!user || !!mismatch || !waitsForHome(segments) || contentReady}
              onGone={() => setSplashGone(true)}
            />
          )}
          <ToastHost />
          <MenuHost />
          <DialogHost />
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
