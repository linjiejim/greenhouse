import { useCallback, useRef, useState } from 'react';
import { Stack, useFocusEffect } from 'expo-router';
import type { ComponentRef } from 'react';
import { useT } from '../lib/i18n';

/** Each directory owns its query; leaving it clears both the native bar and its results. */
export function useDirectoryFilter() {
  const [query, setQuery] = useState('');
  const ref = useRef<ComponentRef<typeof Stack.SearchBar>>(null);
  useFocusEffect(
    useCallback(
      () => () => {
        setQuery('');
        ref.current?.setText('');
      },
      [],
    ),
  );
  return { query, setQuery, ref };
}

export function DirectorySearch({ filter }: { filter: ReturnType<typeof useDirectoryFilter> }) {
  const t = useT();
  return (
    <Stack.SearchBar
      ref={filter.ref}
      placeholder={t('directory.search')}
      onChangeText={(event) => filter.setQuery(event.nativeEvent.text)}
      onCancelButtonPress={() => filter.setQuery('')}
    />
  );
}
