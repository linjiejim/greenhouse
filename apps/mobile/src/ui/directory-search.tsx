import { useCallback, useEffect, useRef, useState } from 'react';
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
      placeholder={t('common.search')}
      // searches match words as typed: no automatic capital ("launch" stays "launch")
      autoCapitalize="none"
      // a bar button beside +, on the title's row (iOS 26); never a second row under the title
      placement="integratedButton"
      allowToolbarIntegration={false}
      onChangeText={(event) => filter.setQuery(event.nativeEvent.text)}
      onCancelButtonPress={() => filter.setQuery('')}
    />
  );
}

/**
 * A search asked for by a bar button (the conversations sheet, whose ✕ stands alone): no field
 * until `open`, then one under the title, focused. Cancel, or leaving it empty, clears the query
 * and hides it again.
 */
export function RevealedSearch({
  filter,
  open,
  onClose,
}: {
  filter: ReturnType<typeof useDirectoryFilter>;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { ref, query, setQuery } = filter;
  useEffect(() => {
    if (!open) return;
    // the native bar attaches on the next layout; focus once it is there
    const timer = setTimeout(() => ref.current?.focus(), 300);
    return () => clearTimeout(timer);
  }, [open, ref]);
  if (!open) return null;
  const close = () => {
    setQuery('');
    onClose();
  };
  return (
    <Stack.SearchBar
      ref={ref}
      placeholder={t('common.search')}
      autoCapitalize="none"
      placement="stacked"
      hideWhenScrolling={false}
      autoFocus
      onChangeText={(event) => setQuery(event.nativeEvent.text)}
      onCancelButtonPress={close}
      onBlur={() => {
        if (!query.trim()) close();
      }}
    />
  );
}
