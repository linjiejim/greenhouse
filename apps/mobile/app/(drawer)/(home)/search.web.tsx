import React from 'react';
import { Stack, useRouter } from 'expo-router';
import { SearchPalette } from '../../../src/shell/desktop-tools.web';
export default function Search() {
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SearchPalette close={() => router.back()} />
    </>
  );
}
