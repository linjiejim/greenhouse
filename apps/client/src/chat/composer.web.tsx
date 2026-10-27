/** Browser input primitive; send, upload and agent state still belong to the shared screens. */
import React, { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react';
import { type TextInput, useWindowDimensions } from 'react-native';
import type { Composer as NativeComposer } from './composer';
import { canSendMessage, MAX_FILES } from './composer-files';
import { NativeMenu } from '../ui/menu.web';
import { Icon } from '../ui/core.web';
import { useT } from '../lib/i18n';
import { typo, useTheme } from '../theme';
import { WIDE_MIN } from '../shell/wide-model';

type Props = React.ComponentProps<typeof NativeComposer>;
export const Composer = memo(
  forwardRef<TextInput, Props>(function Composer(
    {
      value,
      onChangeText,
      onSend,
      working,
      onStop,
      onAttach,
      files,
      onRemoveFile,
      onRetryFiles,
      placeholder,
      autoFocus,
      onHeight,
      bottomInset,
      agents,
      agentId,
      onAgent,
      onFocusChange,
      grouped,
    },
    ref,
  ) {
    const { hex: c, isDark } = useTheme();
    const { width } = useWindowDimensions();
    const t = useT();
    const field = useRef<HTMLTextAreaElement>(null);
    const wrap = useRef<HTMLDivElement>(null);
    const latestHeight = useRef(onHeight);
    latestHeight.current = onHeight;
    useImperativeHandle(
      ref,
      () => ({ focus: () => field.current?.focus(), blur: () => field.current?.blur() }) as TextInput,
      [],
    );
    useEffect(() => {
      if (!wrap.current) return;
      const observer = new ResizeObserver(() =>
        latestHeight.current?.(wrap.current?.getBoundingClientRect().height ?? 64),
      );
      observer.observe(wrap.current);
      return () => observer.disconnect();
    }, []);
    useEffect(() => {
      if (!field.current) return;
      field.current.style.height = '24px';
      field.current.style.height = `${Math.min(156, Math.max(24, field.current.scrollHeight))}px`;
    }, [value]);
    const ready = canSendMessage(value, files) && !working;
    const stop = working && !!onStop;
    const chosen = agents?.find((a) => a.id === agentId) ?? agents?.[0];
    const button: React.CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: width >= WIDE_MIN ? 36 : 44,
      height: width >= WIDE_MIN ? 36 : 44,
      flexShrink: 0,
      border: 0,
      borderRadius: '50%',
    };
    return (
      <div
        ref={wrap}
        data-testid="composer"
        style={{
          padding: width >= WIDE_MIN ? (grouped ? '8px 20px 0' : '8px 28px 20px') : `8px 12px ${Math.max(8, bottomInset)}px`,
          background: c.background,
        }}
      >
        <div
          style={{
            border: `1px solid ${c.separator}`,
            borderRadius: 28,
            padding: 7,
            background: c.background,
            boxShadow: isDark ? undefined : '0 2px 8px rgba(0,0,0,.06)',
          }}
        >
          {files.length ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 8 }}>
              {files.map((f) => (
                <span
                  key={f.id}
                  data-testid="composer-file"
                  style={{ padding: '4px 8px', borderRadius: 8, background: c.tertiaryFill, color: c.label }}
                >
                  {f.name}{' '}
                  {f.status === 'uploading'
                    ? t('common.loading')
                    : f.status === 'error'
                      ? t('composer.uploadFailed')
                      : '✓'}
                  <button
                    aria-label={t('client.removeFile')}
                    onClick={() => onRemoveFile(f.id)}
                    style={{ border: 0, background: 'transparent', color: c.label }}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </span>
              ))}
              {files.some((f) => f.status === 'error') ? (
                <button onClick={onRetryFiles}>{t('common.retry')}</button>
              ) : null}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <NativeMenu
              title={t('client.attach')}
              items={[
                { id: 'files', title: t('composer.files'), icon: 'attach', disabled: files.length >= MAX_FILES },
                { id: 'library', title: t('composer.photos'), icon: 'photos', disabled: files.length >= MAX_FILES },
                ...(agents && agents.length > 1
                  ? [
                      {
                        id: 'agents',
                        title: t('composer.agent', { name: chosen?.name ?? '' }),
                        inline: true,
                        children: agents.map((a) => ({
                          id: `agent:${a.id}`,
                          title: a.name,
                          checked: a.id === chosen?.id,
                        })),
                      },
                    ]
                  : []),
              ]}
              onSelect={(id) =>
                id.startsWith('agent:') ? onAgent?.(id.slice(6)) : onAttach(id as 'files' | 'library')
              }
            >
              <button
                aria-label={t('client.attach')}
                style={{ ...button, color: c.secondaryLabel, background: c.tertiaryFill }}
              >
                <Icon name="plus" size={20} />
              </button>
            </NativeMenu>
            <textarea
              ref={field}
              data-testid="composer-input"
              aria-label={placeholder}
              value={value}
              placeholder={placeholder}
              autoFocus={autoFocus}
              rows={1}
              onChange={(e) => onChangeText(e.target.value)}
              onFocus={() => onFocusChange?.(true)}
              onBlur={() => onFocusChange?.(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (ready) onSend();
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                height: 24,
                maxHeight: 156,
                border: 0,
                resize: 'none',
                outline: 'none',
                padding: 0,
                fontFamily: typo.body.fontFamily,
                fontSize: width >= WIDE_MIN ? typo.callout.fontSize : typo.body.fontSize,
                lineHeight: '24px',
                color: c.label,
                background: 'transparent',
              }}
            />
            <button
              data-testid={stop ? 'composer-stop' : 'composer-send'}
              aria-label={t(stop ? 'composer.stop' : 'composer.send')}
              disabled={!stop && !ready}
              onClick={stop ? onStop : onSend}
              style={{ ...button, background: c.accent, color: c.onAccent, opacity: stop || ready ? 1 : 0.45 }}
            >
              <Icon name={stop ? 'stop' : 'up'} size={20} color={c.onAccent} />
            </button>
          </div>
        </div>
      </div>
    );
  }),
);
