import { Host, Toggle } from '@expo/ui/swift-ui';
import { disabled } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../theme';
import { useLocaleEnv } from './native-form';

/** A system switch sized to its label, for RN content outside a native form. */
export function NativeToggle({
  label,
  value,
  onChange,
  disabled: inactive = false,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  const { isDark } = useTheme();
  const locale = useLocaleEnv();
  return (
    <Host
      matchContents={{ vertical: true }}
      ignoreSafeArea="all"
      colorScheme={isDark ? 'dark' : 'light'}
      modifiers={[locale]}
    >
      <Toggle label={label} isOn={value} onIsOnChange={onChange} modifiers={[disabled(inactive)]} />
    </Host>
  );
}
