import { clearHandoffs } from '../src/lib/handoff';
/**
 * Root layout — bootstraps auth + prefs, applies the appearance, gates routes, and declares the
 * app's native navigation map:
 *
 *  - `(drawer)`        home (动态 / 通知) behind the left drawer with the hub's places
 *  - `notification`    one notification (push taps and Home rows land here), an inline-title page
 *  - `knowledge/*`     the knowledge base (shelves, folders, search) and one document
 *  - `files`, `file-preview`   Files (档案库): shelves, folders, upload; Quick Look with share
 *  - `module/[id]`     the hub's places not on the phone yet (Projects, Tables)
 *  - `settings`        a page-sheet modal with its own stack (account, stations, notifications)
 *  - `sheets/stations` the stations sheet the sign-in page opens
 *  - `login`           full screen, shown when signed out
 *
 * Presentation (push / sheet / modal) is decided here, because it must be known before a screen
 * mounts; titles and toolbar buttons are declared by each screen with `Stack.Screen` /
 * `Stack.Toolbar`.
 *
 * Deep links and push taps may land on any route at cold start: `initialRouteName` anchors the
 * root stack on home, so a page / sheet / modal always has home underneath.
 *
 * Auth gate: signed out on any route but /login and the stations sheet it opens → everything
 * above the root is dismissed, then /login replaces it; signed in on /login → home. A station
 * that speaks another API (src/api/compat.ts) shows why — the server needs updating, or it is
 * not a server this app supports — with the way to another station, never a white screen.
 *
 * `usePushBridge` runs the push side (src/push): registration, taps, banners, badge.
 */

import 'react-native-gesture-handler';
import '../src/share/session';
import '../src/widget/publish';
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Keyboard, Platform, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
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
import { usePushBridge } from '../src/push/use-push';
import { useApplyAppearance, useTheme } from '../src/theme';
import { Splash } from '../src/ui/splash';
import { LoadingState } from '../src/ui/loading-state';
import { DialogHost } from '../src/ui/dialogs';
import { MenuHost } from '../src/ui/menu';
import { ToastHost } from '../src/ui/toast';
import { useT } from '../src/lib/i18n';
import { MismatchScreen } from '../src/shell/mismatch';
import { detailScreen, modalScreen, pageScreen, sheetScreen, stackDefaults } from '../src/ui/nav';
import { sheetEdgeLayout } from '../src/ui/sheet-edge';
import nunitoRegular from '../assets/fonts/Nunito-Regular.ttf';
import nunitoMedium from '../assets/fonts/Nunito-Medium.ttf';
import nunitoSemiBold from '../assets/fonts/Nunito-SemiBold.ttf';
import nunitoBold from '../assets/fonts/Nunito-Bold.ttf';

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

/** Routes a signed-out member may be on: the login page and the stations sheet it opens. */
const SIGNED_OUT_ROUTES = new Set(['login', 'sheets/stations']);

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
    const inAuthGroup = segments[0] === 'login';
    if (!user && !SIGNED_OUT_ROUTES.has(segments.join('/'))) {
      // drop pages / sheets stacked over home first, or they'd stay mounted
      // under the login page (and come back after the next sign-in)
      if (router.canDismiss()) router.dismissAll();
      router.replace('/login');
    } else if (user && inAuthGroup) {
      router.replace('/');
    }
  }, [routesReady, mismatch, user, segments, router]);

  // The app speaks the account's language (src/settings/account-language.ts).
  useAccountLanguage();

  // Pushes (src/push): this phone's registration per signed-in station, opening a tapped
  // notification once the routes are up (switching station first when it came from
  // another), clearing banners and keeping the app icon badge on the unread count.
  usePushBridge(ready);

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
              <MismatchScreen mismatch={mismatch} />
            ) : (
              <Stack
                screenOptions={{ ...stackDefaults(c, hex, isDark), headerShown: false }}
                screenLayout={sheetEdgeLayout}
              >
                {/* home is the stack's root: never popped by the back gesture (the drawer owns horizontal swipes) */}
                <Stack.Screen name="(drawer)" options={{ title: t('nav.home'), gestureEnabled: false }} />
                <Stack.Screen name="login" options={{ animation: 'fade', gestureEnabled: false }} />

                {/* ── pages over home ── */}
                <Stack.Screen name="notification" options={detailScreen(c, { grouped: true })} />
                <Stack.Screen name="knowledge/index" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="knowledge/doc" options={detailScreen(c)} />
                <Stack.Screen name="files" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="file-preview" options={{ ...detailScreen(c), presentation: 'modal' }} />
                <Stack.Screen name="projects/index" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="projects/detail" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="projects/task" options={detailScreen(c, { grouped: true })} />
                <Stack.Screen name="tables/index" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="tables/base" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="tables/table" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="tables/record" options={detailScreen(c, { grouped: true })} />
                <Stack.Screen name="agent/index" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="agent/write" options={detailScreen(c, { grouped: true })} />
                <Stack.Screen name="assistant/index" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="assistant/chat" options={detailScreen(c)} />

                {/* ── sheets ── */}
                <Stack.Screen name="sheets/stations" options={sheetScreen([0.6, 1], { header: true })} />
                <Stack.Screen name="tables/new-record" options={sheetScreen([1], { header: true })} />

                {/* ── modals with their own stack ── */}
                <Stack.Screen name="settings" options={modalScreen()} />
              </Stack>
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
