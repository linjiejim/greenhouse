import { useWindowDimensions } from 'react-native';
import { useShortcut } from '../ui/use-shortcut';
import { WIDE_MIN } from '../shell/wide-model';
export function useChatLayout(options?: { working: boolean; onStop: () => void }) {
  const { width } = useWindowDimensions();
  useShortcut('Escape', () => options?.onStop(), !!options?.working);
  return {
    content: {
      width: '100%' as const,
      maxWidth: 948,
      alignSelf: 'center' as const,
      paddingHorizontal: width >= WIDE_MIN ? 28 : 16,
      gap: 24,
    },
    composer: {
      width: '100%' as const,
      maxWidth: 948,
      alignSelf: 'center' as const,
      left: undefined,
      right: undefined,
    },
  };
}
