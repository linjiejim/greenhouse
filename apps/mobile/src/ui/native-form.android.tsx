/**
 * Material 3 forms — Android's counterpart of ./native-form.tsx (iOS: SwiftUI
 * `Form`). The standard for every Android settings / edit / create screen.
 *
 * One Compose island per screen: `NativeForm` is a full-screen `M3Host`
 * (brand-seeded Material palette, in-app color scheme) around a `LazyColumn`.
 * Inside it:
 *  - `FormSection` — an M3 "connected" list as in Android Settings: rows on
 *    `surfaceContainer`, fully rounded at the group's ends and 2dp apart, the
 *    title in the primary color above and an optional footer below. Put only
 *    row components in it: `FormNavRow` (drills in), `FormCheckRow` (single
 *    choice, radio button), `FormSwitchRow`, `FormSelectRow` (dropdown menu),
 *    `FormValueRow` (read-only label · value), `FormSegmentedRow`,
 *    `FormActionRow` (an action as a row — 退出登录, 删除), `FormSwatchRow`.
 *    Each row is a whole Compose `ListItem`: the ripple covers the row and
 *    TalkBack reads it as one element.
 *  - `FormTextField` — a Material outlined text field (floating label,
 *    supporting / error text, IME action, autofill hint), placed straight in
 *    the form or a `FormFields` group — text fields are not list rows on Android.
 *  - Anything else Compose (`Text`, `Button`…), or RN content in `RNHostView`.
 *
 * Android screens import this module explicitly (`…/ui/native-form.android`) —
 * TypeScript resolves the bare path to the iOS kit. `useLocaleEnv` exists for
 * shared modules that import it (the iOS-only branches that use it never run).
 */

import React, { useState } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  CircularProgressIndicator,
  Column,
  DropdownMenu,
  DropdownMenuItem,
  FlowRow,
  Icon,
  LazyColumn,
  ListItem,
  OutlinedTextField,
  RadioButton,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Switch,
  Text,
  type TextFieldImeAction,
  type TextFieldKeyboardType,
  type TextFieldRef,
  useNativeState,
  Box,
} from '@expo/ui/jetpack-compose';
import {
  background,
  clickable,
  clip,
  combinedClickable,
  fillMaxSize,
  fillMaxWidth,
  padding,
  semantics,
  Shapes,
  size,
} from '@expo/ui/jetpack-compose/modifiers';
import type { IconName } from './core';
import { selectionTick } from './haptics';
import { M3Host, useM3 } from './m3';
// the Android table explicitly: TypeScript resolves the bare path to the iOS one (SF names)
import { toolbarIcon } from './toolbar-icon.android';

export { useNativeState };

/** SwiftUI's locale environment has no Compose counterpart (shared modules import it). */
export function useLocaleEnv(): null {
  return null;
}

/* ------------------------------ containers ------------------------------ */

export function NativeForm({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const m = useM3();
  return (
    <M3Host style={[{ flex: 1 }, style]}>
      <LazyColumn
        verticalArrangement={{ spacedBy: 20 }}
        contentPadding={{ start: 16, end: 16, top: 12, bottom: 40 }}
        modifiers={[fillMaxSize(), background(m.surface)]}
      >
        {children}
      </LazyColumn>
    </M3Host>
  );
}

const FULL = 20;
const SMALL = 4;

/** Corners of row `i` of `n` in a connected group: round at the ends, tight in between. */
function rowShape(i: number, n: number) {
  const top = i === 0 ? FULL : SMALL;
  const bottom = i === n - 1 ? FULL : SMALL;
  return Shapes.RoundedCorner({ topStart: top, topEnd: top, bottomStart: bottom, bottomEnd: bottom });
}

export function FormSection({
  title,
  footer,
  footerError,
  children,
}: {
  title?: string;
  /** A note under the group (plain text, or Compose content). */
  footer?: React.ReactNode;
  /** The footer is a problem with the group's values (error color). */
  footerError?: boolean;
  children?: React.ReactNode;
}) {
  const m = useM3();
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <Column verticalArrangement={{ spacedBy: 8 }} modifiers={[fillMaxWidth()]}>
      {title ? (
        <Text color={m.primary} style={{ typography: 'labelLarge' }} modifiers={[padding(16, 4, 16, 0)]}>
          {title}
        </Text>
      ) : null}
      {rows.length ? (
        <Column verticalArrangement={{ spacedBy: 2 }} modifiers={[fillMaxWidth()]}>
          {rows.map((row, i) => (
            <Box key={i} modifiers={[fillMaxWidth(), clip(rowShape(i, rows.length))]}>
              {row}
            </Box>
          ))}
        </Column>
      ) : null}
      {footer ? (
        typeof footer === 'string' ? (
          <Text color={footerError ? m.error : m.onSurfaceVariant} style={{ typography: 'bodySmall' }} modifiers={[padding(16, 0, 16, 0)]}>
            {footer}
          </Text>
        ) : (
          footer
        )
      ) : null}
    </Column>
  );
}

/** Text fields (and other free-standing controls) stacked with form spacing. */
export function FormFields({ children }: { children: React.ReactNode }) {
  return (
    <Column verticalArrangement={{ spacedBy: 12 }} modifiers={[fillMaxWidth()]}>
      {children}
    </Column>
  );
}

/* --------------------------------- rows --------------------------------- */

function RowIcon({ name, color }: { name: IconName; color?: string }) {
  const m = useM3();
  return <Icon source={toolbarIcon(name)} size={24} tint={color ?? m.onSurfaceVariant} />;
}

/** A data-color dot leading a row (tag color) — sits in the 24dp icon slot. */
function Dot({ color }: { color: string }) {
  return (
    <Box contentAlignment="center" modifiers={[size(24, 24)]}>
      <Box modifiers={[size(12, 12), clip(Shapes.Circle), background(color)]} />
    </Box>
  );
}

function leadingOf(icon?: IconName, iconColor?: string, dot?: string) {
  if (dot) return <Dot color={dot} />;
  return icon ? <RowIcon name={icon} color={iconColor} /> : undefined;
}

/** The ListItem every row is built on: surfaceContainer, whole-row ripple when tappable. */
function Row({
  headline,
  supporting,
  leading,
  trailing,
  onPress,
  onLongPress,
  enabled = true,
  headlineColor,
}: {
  headline: string;
  supporting?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onPress?: () => void;
  /** Long-press action (a row's secondary action, e.g. 移除). */
  onLongPress?: () => void;
  enabled?: boolean;
  headlineColor?: string;
}) {
  const m = useM3();
  const press = !enabled
    ? []
    : onLongPress
      ? [combinedClickable({ onClick: onPress, onLongClick: onLongPress })]
      : onPress
        ? [clickable(onPress)]
        : [];
  return (
    <ListItem colors={{ containerColor: m.surfaceContainer }} modifiers={[fillMaxWidth(), ...press]}>
      <ListItem.HeadlineContent>
        <Text color={enabled ? (headlineColor ?? m.onSurface) : m.outline} style={{ typography: 'bodyLarge' }}>
          {headline}
        </Text>
      </ListItem.HeadlineContent>
      {supporting ? (
        <ListItem.SupportingContent>
          {typeof supporting === 'string' ? (
            <Text color={m.onSurfaceVariant} style={{ typography: 'bodyMedium' }} maxLines={2}>
              {supporting}
            </Text>
          ) : (
            supporting
          )}
        </ListItem.SupportingContent>
      ) : null}
      {leading ? <ListItem.LeadingContent>{leading}</ListItem.LeadingContent> : null}
      {trailing ? <ListItem.TrailingContent>{trailing}</ListItem.TrailingContent> : null}
    </ListItem>
  );
}

/** Drills into another page: label, current value as the supporting line, chevron. */
export function FormNavRow({
  label,
  value,
  icon,
  iconColor,
  dot,
  onPress,
  onLongPress,
}: {
  label: string;
  value?: string;
  icon?: IconName;
  /** Data color for the leading icon (tag / project color). */
  iconColor?: string;
  /** A data-color dot instead of an icon (tags). */
  dot?: string;
  onPress: () => void;
  /** The row's secondary action (删除…) on long press. */
  onLongPress?: () => void;
}) {
  return (
    <Row
      headline={label}
      supporting={value || undefined}
      leading={leadingOf(icon, iconColor, dot)}
      trailing={<RowIcon name="chevR" />}
      onPress={onPress}
      onLongPress={onLongPress}
    />
  );
}

/** One option of a single-choice list: the selected row's radio button is on. */
export function FormCheckRow({
  label,
  detail,
  icon,
  iconColor,
  dot,
  checked,
  onPress,
  onLongPress,
}: {
  label: string;
  detail?: string;
  icon?: IconName;
  iconColor?: string;
  /** A data-color dot instead of an icon (tags). */
  dot?: string;
  checked: boolean;
  onPress: () => void;
  /** The row's secondary action (移除…) on long press. */
  onLongPress?: () => void;
}) {
  return (
    <Row
      headline={label}
      supporting={detail}
      leading={leadingOf(icon, iconColor, dot)}
      trailing={<RadioButton selected={checked} onClick={onPress} />}
      onPress={onPress}
      onLongPress={onLongPress}
    />
  );
}

export function FormSwitchRow({
  label,
  detail,
  value,
  onValueChange,
  enabled = true,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  enabled?: boolean;
}) {
  return (
    <Row
      headline={label}
      supporting={detail}
      enabled={enabled}
      trailing={<Switch value={value} enabled={enabled} onCheckedChange={onValueChange} />}
      onPress={() => onValueChange(!value)}
    />
  );
}

/** Read-only label · value (version, role…), or a spinner while the value loads. */
export function FormValueRow({
  label,
  value,
  loading,
  dot,
  muted,
}: {
  label: string;
  value?: string;
  loading?: boolean;
  /** A data-color dot leading the row (a read-only tag). */
  dot?: string;
  /** Label in the secondary color (empty / status lines: 还没有标签). */
  muted?: boolean;
}) {
  const m = useM3();
  return (
    <Row
      headline={label}
      headlineColor={muted ? m.onSurfaceVariant : undefined}
      leading={dot ? <Dot color={dot} /> : undefined}
      trailing={
        loading ? (
          <CircularProgressIndicator modifiers={[size(20, 20)]} />
        ) : (
          <Text color={m.onSurfaceVariant} style={{ typography: 'bodyLarge' }} maxLines={1}>
            {value ?? ''}
          </Text>
        )
      }
    />
  );
}

/** Pick one of a few options from a dropdown menu anchored to the row (语言, 默认智能体). */
export function FormSelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
  icon,
}: {
  label: string;
  value: T | undefined;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  icon?: IconName;
}) {
  const m = useM3();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value)?.label;
  return (
    <DropdownMenu expanded={open} onDismissRequest={() => setOpen(false)}>
      <DropdownMenu.Trigger>
        <Row
          headline={label}
          supporting={current}
          leading={icon ? <RowIcon name={icon} /> : undefined}
          trailing={<RowIcon name="chevD" />}
          onPress={() => setOpen(true)}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Items>
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            onClick={() => {
              setOpen(false);
              if (o.value !== value) {
                selectionTick();
                onChange(o.value);
              }
            }}
          >
            <DropdownMenuItem.Text>
              <Text style={{ typography: 'bodyLarge' }}>{o.label}</Text>
            </DropdownMenuItem.Text>
            {o.value === value ? (
              <DropdownMenuItem.TrailingIcon>
                <Icon source={toolbarIcon('check')} size={20} tint={m.primary} />
              </DropdownMenuItem.TrailingIcon>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenu.Items>
    </DropdownMenu>
  );
}

/** A labelled segmented choice (主题 跟随系统 / 浅色 / 深色). */
export function FormSegmentedRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <Row
      headline={label}
      supporting={
        <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth(), padding(0, 8, 0, 0)]}>
          {options.map((o) => (
            <SegmentedButton
              key={o.value}
              selected={o.value === value}
              onClick={() => {
                if (o.value === value) return;
                selectionTick();
                onChange(o.value);
              }}
            >
              <SegmentedButton.Label>
                <Text maxLines={1}>{o.label}</Text>
              </SegmentedButton.Label>
            </SegmentedButton>
          ))}
        </SingleChoiceSegmentedButtonRow>
      }
    />
  );
}

/** An action presented as a row — destructive ones (退出登录, 删除) in the error color. */
export function FormActionRow({
  label,
  icon,
  destructive,
  loading,
  enabled = true,
  onPress,
}: {
  label: string;
  icon?: IconName;
  destructive?: boolean;
  loading?: boolean;
  enabled?: boolean;
  onPress: () => void;
}) {
  const m = useM3();
  const color = destructive ? m.error : m.primary;
  return (
    <Row
      headline={label}
      headlineColor={color}
      enabled={enabled && !loading}
      leading={icon ? <RowIcon name={icon} color={color} /> : undefined}
      trailing={loading ? <CircularProgressIndicator modifiers={[size(20, 20)]} /> : undefined}
      onPress={onPress}
    />
  );
}

const SWATCH = 36;

/**
 * A color palette row (data colors only — tag / project palettes): circles in a
 * wrapping row, the selected one marked with a check (Material's color-picker
 * convention). Tapping the selected swatch clears it when `allowNone`.
 */
export function FormSwatchRow({
  colors,
  value,
  onChange,
  nameOf,
  allowNone = false,
}: {
  colors: readonly string[];
  value: string | null;
  onChange: (color: string | null) => void;
  nameOf?: (color: string) => string | null | undefined;
  allowNone?: boolean;
}) {
  const m = useM3();
  const same = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  return (
    <ListItem colors={{ containerColor: m.surfaceContainer }} modifiers={[fillMaxWidth()]}>
      <ListItem.HeadlineContent>
        <FlowRow horizontalArrangement={{ spacedBy: 14 }} verticalArrangement={{ spacedBy: 14 }} modifiers={[padding(0, 4, 0, 4)]}>
          {colors.map((col) => {
            const selected = same(value, col);
            return (
              <Box
                key={col}
                contentAlignment="center"
                modifiers={[
                  size(SWATCH, SWATCH),
                  clip(Shapes.Circle),
                  background(col),
                  semantics({ contentDescription: `${nameOf?.(col) || col}${selected ? ' ✓' : ''}` }),
                  clickable(() => {
                    if (selected) {
                      if (!allowNone) return;
                      selectionTick();
                      onChange(null);
                      return;
                    }
                    selectionTick();
                    onChange(col);
                  }),
                ]}
              >
                {selected ? <Icon source={toolbarIcon('check')} size={22} tint="#FFFFFF" /> : null}
              </Box>
            );
          })}
        </FlowRow>
      </ListItem.HeadlineContent>
    </ListItem>
  );
}

/* ------------------------------ text fields ------------------------------ */

export type FormTextFieldRef = TextFieldRef;

/**
 * A Material outlined text field. The field owns its text (`state` from
 * `useNativeState`), like the iOS kit — read it with `state.get()` on submit;
 * `onChangeText` mirrors edits for enabling buttons / clearing errors.
 */
export function FormTextField({
  label,
  state,
  onChangeText,
  placeholder,
  keyboard,
  autofill,
  secure,
  imeAction,
  onSubmit,
  supporting,
  error,
  autoFocus,
  multiline,
  enabled = true,
  fieldRef,
}: {
  label: string;
  state: ReturnType<typeof useNativeState<string>>;
  onChangeText?: (text: string) => void;
  placeholder?: string;
  keyboard?: TextFieldKeyboardType;
  /** Autofill hint (`'emailAddress'`, `'password'`, `'username'`…). */
  autofill?: string;
  secure?: boolean;
  imeAction?: TextFieldImeAction;
  onSubmit?: (text: string) => void;
  /** Help text under the field (replaced by `error` when set). */
  supporting?: string;
  error?: string | null;
  autoFocus?: boolean;
  multiline?: boolean;
  enabled?: boolean;
  fieldRef?: React.Ref<TextFieldRef>;
}) {
  const m = useM3();
  const note = error || supporting;
  const submit = onSubmit
    ? imeAction === 'next'
      ? { onNext: onSubmit }
      : imeAction === 'search'
        ? { onSearch: onSubmit }
        : imeAction === 'send'
          ? { onSend: onSubmit }
          : imeAction === 'go'
            ? { onGo: onSubmit }
            : { onDone: onSubmit }
    : undefined;
  return (
    <OutlinedTextField
      ref={fieldRef}
      value={state}
      onValueChange={onChangeText}
      singleLine={!multiline}
      minLines={multiline ? 3 : undefined}
      autoFocus={autoFocus}
      enabled={enabled}
      isError={!!error}
      visualTransformation={secure ? 'password' : 'none'}
      keyboardOptions={{
        keyboardType: secure ? 'password' : keyboard,
        imeAction: imeAction ?? (multiline ? 'default' : 'done'),
        autoCorrectEnabled: !secure && keyboard !== 'email' && keyboard !== 'uri',
        capitalization: 'none',
      }}
      keyboardActions={submit}
      modifiers={[fillMaxWidth(), ...(autofill ? [semantics({ contentType: autofill })] : [])]}
    >
      <OutlinedTextField.Label>
        <Text>{label}</Text>
      </OutlinedTextField.Label>
      {placeholder ? (
        <OutlinedTextField.Placeholder>
          <Text color={m.onSurfaceVariant}>{placeholder}</Text>
        </OutlinedTextField.Placeholder>
      ) : null}
      {note ? (
        <OutlinedTextField.SupportingText>
          <Text color={error ? m.error : m.onSurfaceVariant}>{note}</Text>
        </OutlinedTextField.SupportingText>
      ) : null}
    </OutlinedTextField>
  );
}
