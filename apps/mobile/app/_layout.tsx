/**
 * Root layout — bootstraps auth + prefs, applies the appearance preference,
 * gates routes, and declares the app's native navigation map.
 *
 * Navigation map (all native — UINavigationController / sheets):
 *  - `(drawer)`            the conversation surface behind the left drawer (home)
 *  - `knowledge/*`, `projects/*`  pushed pages with large titles
 *  - `settings`            a page-sheet modal with its own stack
 *  - `peek/*`, `sheets/*`  form sheets (detail previews, pickers, short forms)
 *  - `login`               full screen, shown when signed out
 *
 * Presentation (push / sheet / modal) is decided here, because it must be
 * known before a screen mounts; titles and toolbar buttons are declared by each
 * screen with `Stack.Screen` / `Stack.Toolbar`.
 *
 * Deep links (widget, `greenhouse://settings`…) may land on any route at cold
 * start: `unstable_settings.initialRouteName` anchors the root stack on the
 * conversation, so a deep-linked page / sheet / modal always has home
 * underneath (a back button, a sheet that can be dismissed) instead of
 * becoming the stack root. Home itself is never swipe-popped.
 *
 * Auth gate: signed out on any route but /login and the stations sheet it
 * opens → everything above the root is dismissed, then /login replaces it (so
 * no signed-in screen survives under the login page); signed in on /login →
 * home.
 */

import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { AppState, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '../src/store/auth';
import { usePrefs } from '../src/store/prefs';
import { setOnUnauthorized } from '../src/api/client';
import { clearWidgetSnapshot, refreshWidgetSnapshot } from '../src/lib/widget-snapshot';
import { useApplyAppearance, useTheme } from '../src/theme';
import { Spinner } from '../src/ui/core';
import { ToastHost } from '../src/ui/toast';
import { useT } from '../src/lib/i18n';
import { detailScreen, modalScreen, pageScreen, sheetScreen, stackDefaults } from '../src/ui/nav';

export const unstable_settings = { initialRouteName: '(drawer)' };

/** Routes a signed-out user may be on: the login page and the stations sheet it opens. */
const SIGNED_OUT_ROUTES = new Set(['login', 'sheets/stations']);

export default function RootLayout() {
  useApplyAppearance();
  const { colors: c, hex } = useTheme();
  const t = useT();
  const bootstrap = useAuth((s) => s.bootstrap);
  const loading = useAuth((s) => s.loading);
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

  // Redirect based on auth state once bootstrap resolves.
  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === 'login';
    if (!user && !SIGNED_OUT_ROUTES.has(segments.join('/'))) {
      // drop pages / sheets stacked over home first, or they'd stay mounted
      // under the login page (and come back after the next sign-in)
      if (router.canDismiss()) router.dismissAll();
      router.replace('/login');
    } else if (user && inAuthGroup) {
      router.replace('/');
    }
  }, [loading, user, segments, router]);

  // Home-screen widget snapshot: publish after login resolves and on every
  // background transition; clear on logout so the widget degrades to launcher.
  const lang = usePrefs((s) => s.lang);
  useEffect(() => {
    if (loading) return;
    if (!user) {
      clearWidgetSnapshot();
      return;
    }
    void refreshWidgetSnapshot(user.nickname ?? '', lang);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') void refreshWidgetSnapshot(user.nickname ?? '', lang);
    });
    return () => sub.remove();
  }, [loading, user, lang]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <StatusBar style="auto" />
          {loading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background }}>
              <Spinner size="large" />
            </View>
          ) : (
            <Stack screenOptions={{ ...stackDefaults(c, hex), headerShown: false }}>
              {/* title = the back-button label (a11y) for pages pushed over the conversation */}
              {/* home is the stack's root: never popped by the back gesture (the drawer owns horizontal swipes) */}
              <Stack.Screen name="(drawer)" options={{ title: t('drawer.chats'), gestureEnabled: false }} />
              <Stack.Screen name="login" options={{ animation: 'fade', gestureEnabled: false }} />
              <Stack.Screen name="chat/[id]" options={{ animation: 'none' }} />

              {/* ── knowledge ── */}
              <Stack.Screen name="knowledge/index" options={pageScreen(c)} />
              <Stack.Screen name="knowledge/[slug]" options={detailScreen(c)} />
              {/* editor: page sheet with its own nav bar; FormChrome blocks swipe-to-dismiss only while there are unsaved edits */}
              <Stack.Screen name="knowledge/edit" options={{ ...detailScreen(c), presentation: 'modal' }} />
              <Stack.Screen name="knowledge/versions" options={sheetScreen([0.6, 1], { header: true })} />

              {/* ── projects ── */}
              <Stack.Screen name="projects/index" options={pageScreen(c)} />
              <Stack.Screen name="projects/[id]" options={detailScreen(c)} />
              <Stack.Screen name="projects/task/[taskId]" options={detailScreen(c, { grouped: true })} />
              <Stack.Screen name="projects/task-form" options={sheetScreen([1], { header: true })} />
              <Stack.Screen name="projects/project-form" options={sheetScreen([1], { header: true })} />
              <Stack.Screen name="projects/members" options={sheetScreen([0.6, 1], { header: true })} />
              <Stack.Screen name="projects/activity" options={sheetScreen([0.6, 1], { header: true })} />

              {/* ── detail previews (web "peek" drawers → bottom sheets) ── */}
              <Stack.Screen name="peek/doc/[slug]" options={sheetScreen([0.6, 1], { header: true })} />
              <Stack.Screen name="peek/project/[id]" options={sheetScreen([0.6, 1], { header: true })} />
              <Stack.Screen name="peek/source" options={sheetScreen([0.6, 1], { header: true })} />
              <Stack.Screen name="peek/tools" options={sheetScreen([0.6, 1], { header: true })} />
              <Stack.Screen name="peek/refs" options={sheetScreen([0.6, 1], { header: true })} />

              {/* ── pickers / short forms ── */}
              <Stack.Screen name="sheets/stations" options={sheetScreen([0.6, 1], { header: true })} />
              <Stack.Screen name="sheets/session-tags" options={sheetScreen([0.6, 1], { header: true })} />
              <Stack.Screen name="sheets/tag-editor" options={sheetScreen([0.6], { header: true })} />

              {/* ── modals with their own stack ── */}
              <Stack.Screen name="settings" options={modalScreen()} />
              <Stack.Screen name="table" options={{ ...detailScreen(c), presentation: 'modal' }} />
            </Stack>
          )}
          <ToastHost />
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
