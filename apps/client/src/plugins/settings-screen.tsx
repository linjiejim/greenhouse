import React, { useCallback, useState } from 'react';
import { ScrollView, View, Text, TextInput, Switch } from 'react-native';
import { get, put } from '../api/client';
import { useResource } from '../data/use-resource';
import { captureIdentity } from '../data/identity';
import { Screen } from '../ui/screen';
import { NativeButton } from '../ui/button';
import { LoadingState, EmptyState } from '../ui/empty';
import { alertError } from '../ui/dialogs';
import { useT } from '../lib/i18n';
import { space, typo, useTheme } from '../theme';
interface Setting {
  key: string;
  label?: string;
  description?: string;
  type: string;
  secret?: boolean;
  value?: unknown;
  has_value?: boolean;
  flag?: { effective: boolean; fallback: boolean } | null;
}
export function SettingsForm({ keys, title }: { keys: string[]; title: string }) {
  const t = useT(),
    { colors: c } = useTheme();
  const data = useResource(useCallback(() => get<{ settings: Setting[] }>('/api/admin/settings'), []));
  const [draft, setDraft] = useState<Record<string, string | boolean>>({}),
    [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    const values: Record<string, unknown> = {};
    try {
      for (const setting of data.data?.settings ?? []) {
        if (!keys.includes(setting.key) || !(setting.key in draft)) continue;
        const raw = draft[setting.key];
        values[setting.key] =
          setting.type === 'number' ? Number(raw) : setting.type === 'json' ? JSON.parse(String(raw)) : raw;
      }
    } catch {
      alertError(t('library.failed'));
      return;
    }
    const current = captureIdentity();
    setBusy(true);
    const r = await put('/api/admin/settings', { values });
    if (!current()) return;
    setBusy(false);
    if (!r.ok) {
      alertError(t('library.failed'), r.message);
      return;
    }
    setDraft({});
    void data.refresh();
  };
  return (
    <>
      <Screen title={title} />
      <ScrollView
        style={{ flex: 1, backgroundColor: c.groupedBackground }}
        contentContainerStyle={{ padding: space.xxl, gap: space.lg }}
      >
        {!data.data ? (
          data.loading ? (
            <LoadingState />
          ) : (
            <EmptyState
              icon="gear"
              title={data.error?.message || t('places.pluginError')}
              onRetry={data.error?.status === 403 ? undefined : () => void data.refresh()}
            />
          )
        ) : (
          <>
            {keys.map((key) => {
              const setting = data.data?.settings.find((s) => s.key === key);
              if (!setting) return null;
              const value = draft[key] ?? setting.value ?? setting.flag?.effective ?? '';
              return (
                <View key={key} style={{ gap: space.sm }}>
                  <Text style={{ ...typo.body, color: c.label }}>{setting.label || key}</Text>
                  {setting.type === 'boolean' ? (
                    <Switch
                      accessibilityLabel={key}
                      value={Boolean(value)}
                      onValueChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                    />
                  ) : (
                    <TextInput
                      accessibilityLabel={key}
                      secureTextEntry={setting.secret}
                      placeholder={setting.secret && setting.has_value ? t('places.configured') : ''}
                      value={
                        setting.secret
                          ? String(draft[key] ?? '')
                          : typeof value === 'object'
                            ? JSON.stringify(value)
                            : String(value)
                      }
                      multiline={setting.type === 'text' || setting.type === 'json'}
                      onChangeText={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                      style={{
                        ...typo.body,
                        color: c.label,
                        backgroundColor: c.secondaryGroupedBackground,
                        borderWidth: 1,
                        borderColor: c.separator,
                        borderRadius: 8,
                        padding: space.md,
                      }}
                    />
                  )}
                  {setting.description ? (
                    <Text style={{ ...typo.footnote, color: c.secondaryLabel }}>{setting.description}</Text>
                  ) : null}
                </View>
              );
            })}
            <NativeButton
              label={t('common.save')}
              disabled={busy || !Object.keys(draft).length}
              onPress={() => void save()}
            />
          </>
        )}
      </ScrollView>
    </>
  );
}
