import { FormSwitchRow } from './native-form.android';
import { M3Host } from './m3';

export function NativeToggle({
  label,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <M3Host matchContents={{ vertical: true }}>
      <FormSwitchRow label={label} value={value} onValueChange={onChange} enabled={!disabled} />
    </M3Host>
  );
}
