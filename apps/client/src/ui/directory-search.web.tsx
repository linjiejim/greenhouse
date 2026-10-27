import React, { useRef, useState } from 'react';
import { TextInput } from 'react-native';
import { useT } from '../lib/i18n';
import { space, typo, useTheme } from '../theme';
export function useDirectoryFilter() {
  const [query, setQuery] = useState('');
  const ref = useRef<TextInput>(null);
  return { query, setQuery, ref };
}
export function DirectorySearch({ filter }: { filter: ReturnType<typeof useDirectoryFilter> }) {
  const t = useT();
  const { hex: c } = useTheme();
  return (
    <TextInput
      ref={filter.ref}
      value={filter.query}
      onChangeText={filter.setQuery}
      accessibilityLabel={t('common.search')}
      placeholder={t('common.search')}
      placeholderTextColor={c.placeholder}
      style={{
        ...typo.body,
        color: c.label,
        padding: space.sm,
        margin: space.sm,
        backgroundColor: c.fill,
        borderRadius: 8,
      }}
    />
  );
}
export function RevealedSearch({
  filter,
  open,
}: {
  filter: ReturnType<typeof useDirectoryFilter>;
  open: boolean;
  onClose: () => void;
}) {
  return open ? <DirectorySearch filter={filter} /> : null;
}
