/**
 * Root layout — bootstraps auth, gates routes, and provides the gesture +
 * bottom-sheet + safe-area context the whole app relies on.
 *
 * Every screen draws its own header (to match the Sage design), so the native
 * stack runs headerless.
 */

import 'react-native-gesture-handler';
import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { KeyboardProvider } from '../src/lib/keyboard-controller-compat';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from '../src/store/auth';
import { usePrefs } from '../src/store/prefs';
import { setOnUnauthorized } from '../src/api/client';
import { useTheme } from '../src/theme';

export default function RootLayout() {
  const { colors: c, isDark } = useTheme();
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
    if (!user && !inAuthGroup) {
      router.replace('/login');
    } else if (user && inAuthGroup) {
      router.replace('/');
    }
  }, [loading, user, segments, router]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <BottomSheetModalProvider>
          <StatusBar style={isDark ? 'light' : 'dark'} />
          {loading ? (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
              <ActivityIndicator color={c.accent} size="large" />
            </View>
          ) : (
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.bg } }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="login" />
              <Stack.Screen name="chat/[id]" options={{ animation: 'slide_from_right' }} />
              <Stack.Screen name="knowledge/index" options={{ animation: 'slide_from_right' }} />
              <Stack.Screen name="knowledge/[slug]" options={{ animation: 'slide_from_right' }} />
              <Stack.Screen name="settings" options={{ animation: 'slide_from_right' }} />
              <Stack.Screen name="table" options={{ animation: 'slide_from_bottom' }} />
            </Stack>
          )}
          </BottomSheetModalProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
