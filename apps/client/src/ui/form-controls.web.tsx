/**
 * Browser form controls used by the five form views; behavior stays in their shared hooks. In a
 * desktop dialog (src/ui/dialog-frame.ts) they draw the shared Controls (src/shell/client.css):
 * sections without cards, labels above selects and dates, switches; on a phone-width window the
 * inset-grouped sheet look.
 */
import React, { Children, createContext, forwardRef, useContext, useId, useImperativeHandle, useRef, useState } from 'react';
import { Text as RNText, View } from 'react-native';
import { radius, space, typo, useTheme } from '../theme';
import { NativeButton } from './button.web';
import { NativeToggle } from './toggle.web';
import { localDay } from '../data/tasks';
import { DialogFrameContext } from './dialog-frame';

/** Text in a desktop section's footer reads as a hint. */
const HintText = createContext(false);
type Modifier = { type: string; value?: any };
type Props = { children?: React.ReactNode; modifiers?: Modifier[] };
export const font = (value: any = {}): Modifier => ({ type: 'font', value });
export const foregroundStyle = (value: any): Modifier => ({ type: 'color', value });
export const frame = (value: any): Modifier => ({ type: 'frame', value });
export const lineLimit = (value: number): Modifier => ({ type: 'lines', value });
export const tag = (value: string): Modifier => ({ type: 'tag', value });
export const pickerStyle = (_value: string): Modifier => ({ type: 'picker' });
export const keyboardType = (value: string): Modifier => ({ type: 'keyboard', value });
export const accessibilityElement = (_value: string): Modifier => ({ type: 'accessibility' });
export const accessibilityHidden = (_value = true): Modifier => ({ type: 'hidden' });
export const accessibilityLabel = (value: string): Modifier => ({ type: 'label', value });
export function Text({ children, modifiers = [] }: Props) {
  const { hex: c } = useTheme();
  const hint = useContext(HintText);
  if (hint && !modifiers.length) return <span className="gh-hint">{children}</span>;
  const color = modifiers.find((m) => m.type === 'color')?.value;
  const f = modifiers.find((m) => m.type === 'font')?.value;
  const role = f?.textStyle;
  const textStyle =
    role === 'title2' ? typo.title2 : role === 'title3' ? typo.title3 : role === 'footnote' ? typo.footnote : typo.body;
  return (
    <RNText
      style={{
        ...textStyle,
        color: typeof color === 'string' ? color : c.label,
        fontWeight: f?.weight === 'semibold' ? '600' : textStyle.fontWeight,
      }}
    >
      {children}
    </RNText>
  );
}
export function Section({
  children,
  title,
  footer,
  header,
}: Props & { title?: string; footer?: React.ReactNode; header?: React.ReactNode }) {
  const { hex: c } = useTheme();
  if (useContext(DialogFrameContext))
    return (
      <fieldset className="gh-form-section">
        {title ? <legend>{title}</legend> : null}
        {header}
        {children}
        {footer ? <HintText.Provider value={true}>{footer}</HintText.Provider> : null}
      </fieldset>
    );
  return (
    <View style={{ gap: space.sm }}>
      {header}
      {title ? <RNText style={{ ...typo.footnote, color: c.secondaryLabel }}>{title}</RNText> : null}
      <View
        style={{
          backgroundColor: c.secondaryGroupedBackground,
          borderColor: c.separator,
          borderWidth: 1,
          borderRadius: radius.md,
          padding: space.md,
          gap: space.md,
        }}
      >
        {children}
      </View>
      {footer}
    </View>
  );
}
export function HStack({ children, spacing = 8 }: Props & { spacing?: number }) {
  return <View style={{ flexDirection: 'row', gap: spacing, alignItems: 'center' }}>{children}</View>;
}
export function VStack({ children, spacing = 8 }: Props & { spacing?: number; alignment?: string }) {
  return <View style={{ gap: spacing }}>{children}</View>;
}

export function RNHostView({ children }: Props & { matchContents?: boolean }) {
  return <>{children}</>;
}
export function LabeledContent({ label, children }: Props & { label: string }) {
  return (
    <HStack>
      <Text>{label}</Text>
      <View style={{ flex: 1 }} />
      {children}
    </HStack>
  );
}
export function Button({
  label,
  children,
  onPress,
  role,
}: Props & { label?: string; onPress: () => void; role?: string }) {
  const { hex: c } = useTheme();
  return label ? (
    <NativeButton label={label} onPress={onPress} destructive={role === 'destructive'} />
  ) : (
    <button
      type="button"
      className="gh-form-button"
      onClick={onPress}
      style={{
        background: 'transparent',
        border: 0,
        padding: 0,
        color: role === 'destructive' ? c.red : c.accent,
        font: 'inherit',
        textAlign: 'left',
      }}
    >
      {children}
    </button>
  );
}
export function useNativeState(initial: string) {
  const value = useRef(initial);
  return {
    get: () => value.current,
    set: (next: string) => {
      value.current = next;
    },
  };
}
export const TextField = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  {
    text: ReturnType<typeof useNativeState>;
    placeholder?: string;
    onTextChange?: (v: string) => void;
    axis?: string;
    autoFocus?: boolean;
    modifiers?: Modifier[];
  }
>(function TextField({ text, placeholder, onTextChange, axis, autoFocus, modifiers = [] }, ref) {
  const [value, setValue] = useState(text.get());
  const input = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => input.current!);
  const props = {
    value,
    placeholder,
    autoFocus,
    'aria-label': placeholder,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      text.set(e.target.value);
      setValue(e.target.value);
      onTextChange?.(e.target.value);
    },
    className: 'gh-input',
    style: { width: '100%' },
  };
  if (axis === 'vertical')
    return (
      <textarea
        {...props}
        ref={input as React.Ref<HTMLTextAreaElement>}
        rows={modifiers.find((m) => m.type === 'lines')?.value ?? 8}
      />
    );
  return (
    <input
      {...props}
      ref={input as React.Ref<HTMLInputElement>}
      type={modifiers.some((m) => m.type === 'keyboard' && m.value === 'decimal-pad') ? 'number' : 'text'}
    />
  );
});
export function Picker({
  label,
  selection,
  onSelectionChange,
  children,
}: Props & { label: string; selection: string; onSelectionChange: (v: string) => void }) {
  const { hex: c } = useTheme();
  const id = useId();
  const options = Children.toArray(children).filter(React.isValidElement) as React.ReactElement<Props>[];
  const choices = options.map((o, i) => (
    <option key={i} value={o.props.modifiers?.find((m) => m.type === 'tag')?.value}>
      {o.props.children as string}
    </option>
  ));
  if (useContext(DialogFrameContext))
    return (
      <div className="gh-field">
        <label htmlFor={id}>{label}</label>
        <select id={id} value={selection} onChange={(e) => onSelectionChange(e.target.value)} className="gh-input">
          {choices}
        </select>
      </div>
    );
  return (
    <label
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: space.md, color: c.label }}
    >
      {label}
      <select
        aria-label={label}
        value={selection}
        onChange={(e) => onSelectionChange(e.target.value)}
        className="gh-input"
      >
        {choices}
      </select>
    </label>
  );
}
export function Toggle({
  label,
  isOn,
  onIsOnChange,
}: {
  label: string;
  isOn: boolean;
  onIsOnChange: (v: boolean) => void;
}) {
  if (useContext(DialogFrameContext))
    return (
      <label className="gh-check">
        <input
          type="checkbox"
          role="switch"
          className="gh-switch"
          checked={isOn}
          aria-checked={isOn}
          onChange={(e) => onIsOnChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
    );
  return <NativeToggle label={label} value={isOn} onChange={onIsOnChange} />;
}
export function DatePicker({
  title,
  selection,
  onDateChange,
}: {
  title: string;
  selection: Date;
  displayedComponents?: string[];
  onDateChange: (date: Date) => void;
}) {
  const { hex: c } = useTheme();
  const id = useId();
  const input = (
    <input
      id={id}
      type="date"
      className="gh-input"
      aria-label={title}
      value={localDay(selection)}
      onChange={(e) => {
        const [y, m, d] = e.target.value.split('-').map(Number);
        if (y && m && d) onDateChange(new Date(y, m - 1, d));
      }}
    />
  );
  if (useContext(DialogFrameContext))
    return (
      <div className="gh-field">
        <label htmlFor={id}>{title}</label>
        {input}
      </div>
    );
  return (
    <label style={{ display: 'flex', justifyContent: 'space-between', color: c.label }}>
      {title}
      {input}
    </label>
  );
}
export function Slider({
  value,
  min,
  max,
  step,
  onValueChange,
  modifiers = [],
}: Props & {
  value: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (n: number) => void;
  minimumValueLabel?: React.ReactNode;
  maximumValueLabel?: React.ReactNode;
}) {
  return (
    <input
      type="range"
      aria-label={modifiers.find((m) => m.type === 'label')?.value}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onValueChange(Number(e.target.value))}
    />
  );
}
