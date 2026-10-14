/**
 * Root layout — bootstraps auth + prefs, applies the appearance, gates routes, and declares the
 * app's native navigation map (PRD §6.2):
 *
 *  - `(drawer)`        the conversation surface behind the left drawer (home; every conversation is
 *                      the same route with `?c=` — src/shell/nav.ts)
 *  - `agents/*`, `runs/*`, `notifications`   pushed pages with large titles (agent and run details:
 *                      inline titles)
 *  - `settings`        a page-sheet modal with its own stack
 *  - `request`, `new-room`, `room-people`, `agents/edit`, `peek/*`, `sheets/*`   sheets (a card in
 *                      full, short forms, details)
 *  - `computer`        an Agent's computer (full-screen modal); `table`, `peek/diagram`, `peek/html`,
 *                      `file-preview` full-screen viewers
 *  - `login`           full screen, shown when signed out
 *
 * Presentation (push / sheet / modal) is decided here, because it must be known before a screen
 * mounts; titles and toolbar buttons are declared by each screen with `Stack.Screen` /
 * `Stack.Toolbar`.
 *
 * Deep links and push taps may land on any route at cold start: `initialRouteName` anchors the
 * root stack on the conversation, so a page / sheet / modal always has home underneath.
 *
 * Auth gate: signed out on any route but /login and the stations sheet it opens → everything
 * above the root is dismissed, then /login replaces it; signed in on /login → home. A station
 * that speaks another API (src/api/compat.ts) shows why — update the app, or the server is still
 * v1 — with the way to another station, never a white screen.
 *
 * <RealtimeBridge/> runs the app's one WebSocket (src/realtime). `usePushBridge` runs the push side
 * (src/push): registration, taps, banners, badge. `useLiveActivities` keeps background runs on the
 * Lock Screen (src/live-activity). <WidgetArtHost/> draws the home-screen widget's faces off screen.
 */

import 'react-native-gesture-handler';
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '../src/store/auth';
import { usePrefs } from '../src/store/prefs';
import { useStations } from '../src/store/stations';
import { StartupContent, waitsForHome } from '../src/startup/content';
import { StartupContext } from '../src/startup/context';
import { setOnUnauthorized } from '../src/api/client';
import { useWidgetSnapshot } from '../src/widget/snapshot';
import { useAccountLanguage } from '../src/settings/account-language';
import { usePushBridge } from '../src/push/use-push';
import { useLiveActivities } from '../src/live-activity/use-live-activities';
import { WidgetArtHost } from '../src/widget/art-host';
import { useApplyAppearance, useTheme } from '../src/theme';
import { Splash } from '../src/ui/splash';
import { LoadingState } from '../src/ui/loading-state';
import { DialogHost } from '../src/ui/dialogs';
import { MenuHost } from '../src/ui/menu';
import { ToastHost } from '../src/ui/toast';
import { useT } from '../src/lib/i18n';
import { RealtimeBridge } from '../src/realtime/realtime-bridge';
import { MismatchScreen } from '../src/shell/mismatch';
import { detailScreen, modalScreen, pageScreen, sheetScreen, stackDefaults } from '../src/ui/nav';
import { sheetEdgeLayout } from '../src/ui/sheet-edge';
import nunitoRegular from '../assets/fonts/Nunito-Regular.ttf';
import nunitoMedium from '../assets/fonts/Nunito-Medium.ttf';
import nunitoSemiBold from '../assets/fonts/Nunito-SemiBold.ttf';
import nunitoBold from '../assets/fonts/Nunito-Bold.ttf';

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
  const { colors: c, hex } = useTheme();
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
    setOnUnauthorized(() => logout());
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
  const startup = useMemo(() => ({ content, covered: !splashGone && !startupError }), [content, splashGone, startupError]);

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

  // Home-screen widget snapshot (src/widget/snapshot.ts): published after sign-in, as the
  // directory changes in the foreground and on every background transition; cleared on
  // sign-out and station switch so the widget degrades to launcher-only.
  useWidgetSnapshot();

  // The app speaks the account's language and wears its theme (src/settings/account-language.ts).
  useAccountLanguage();

  // Pushes (src/push): this phone's registration per signed-in station, opening a tapped
  // notification once the routes are up (switching station first when it came from
  // another), clearing banners and keeping the app icon badge on the bell's number.
  usePushBridge(ready);

  // Background runs as Live Activities (lock screen / Dynamic Island), when the member
  // switched them on in Settings → 通知 (src/live-activity).
  useLiveActivities();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <StatusBar style="auto" />
          <RealtimeBridge />
          <WidgetArtHost />
          <StartupContext.Provider value={startup}>
            {!routesReady ? (
              <View style={{ flex: 1, backgroundColor: c.background }}>
                <LoadingState />
              </View>
            ) : mismatch ? (
              <MismatchScreen mismatch={mismatch} />
            ) : (
              <Stack screenOptions={{ ...stackDefaults(c, hex), headerShown: false }} screenLayout={sheetEdgeLayout}>
                {/* home is the stack's root: never popped by the back gesture (the drawer owns horizontal swipes) */}
                <Stack.Screen name="(drawer)" options={{ title: t('nav.chat'), gestureEnabled: false }} />
                <Stack.Screen name="login" options={{ animation: 'fade', gestureEnabled: false }} />

                {/* ── pages over the conversation ── */}
                <Stack.Screen name="notifications" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="agents/index" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="agents/[id]" options={detailScreen(c, { grouped: true })} />
                <Stack.Screen name="runs/index" options={pageScreen(c, { grouped: true })} />
                <Stack.Screen name="runs/[id]" options={detailScreen(c)} />

                {/* ── sheets: a card in full, short forms, details ── */}
                <Stack.Screen name="request" options={sheetScreen([1], { header: true })} />
                <Stack.Screen name="agents/edit" options={sheetScreen([1], { header: true })} />
                <Stack.Screen name="new-room" options={sheetScreen([1], { header: true })} />
                <Stack.Screen name="room-people" options={sheetScreen([0.6, 1], { header: true })} />
                <Stack.Screen name="peek/steps" options={sheetScreen([0.6, 1], { header: true })} />
                <Stack.Screen name="peek/sources" options={sheetScreen([0.6, 1], { header: true })} />
                <Stack.Screen name="sheets/stations" options={sheetScreen([0.6, 1], { header: true })} />

                {/* an Agent's computer: full screen, no swipe-down (fingers on the screen are the computer's) */}
                <Stack.Screen name="computer" options={{ ...detailScreen(c), presentation: 'fullScreenModal', gestureEnabled: false }} />

                {/* ── modals with their own stack ── */}
                <Stack.Screen name="settings" options={modalScreen()} />
                <Stack.Screen name="file-preview" options={{ ...detailScreen(c), presentation: 'modal' }} />
                <Stack.Screen name="table" options={{ ...detailScreen(c), presentation: 'modal' }} />
                <Stack.Screen name="peek/diagram" options={{ ...detailScreen(c), presentation: 'modal' }} />
                <Stack.Screen name="peek/html" options={{ ...detailScreen(c), presentation: 'modal' }} />
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
