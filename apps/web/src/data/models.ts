import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';

/** The models I may pick (an Agent's, a chat's); a picker shows only when there is a choice. */
export function useModelChoices() {
  return useQuery({ queryKey: ['me', 'models'], queryFn: () => api.me.models(), staleTime: 60_000 });
}

/**
 * Picker options: the workspace's default, stronger and faster picks, then every model I can
 * reach. `current` stays listed even after its model went away, so a picker never looks empty.
 */
export function useModelOptions(current?: string | null) {
  const { t } = useI18n();
  const choices = useModelChoices().data?.items ?? [];
  const options: { value: string; label: string; description?: string }[] = [
    { value: 'default', label: t('agents.modelDefault') },
    { value: 'strong', label: t('agents.modelStrong') },
    { value: 'fast', label: t('agents.modelFast') },
    ...choices.map((choice) => ({
      value: choice.ref,
      label: choice.label,
      description: choice.personal ? t('agents.modelMine', { name: choice.instance }) : choice.instance,
    })),
  ];
  if (current && !options.some((option) => option.value === current)) options.push({ value: current, label: current });
  return { options, available: choices.length > 1 };
}
