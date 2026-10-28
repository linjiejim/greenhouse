/**
 * Native toolbar buttons (./screen-actions.ios.tsx) keep the press handler they were last given
 * until the header catches up with the screen, a beat later. A relay gives each button one stable
 * handler that runs the screen's newest `onPress`, so Save tapped right after typing saves what was
 * typed rather than the text from the render before.
 */
import type { ScreenAction } from './screen-action-types';

type Pressable = Pick<ScreenAction, 'id' | 'onPress'> & { menu?: readonly Pick<ScreenAction, 'id' | 'onPress'>[] };

export interface PressRelay {
  /** Take the newest handlers; call after every commit. */
  update(actions: readonly Pressable[]): void;
  /** The stable handler for a button, or for `menuId` inside button `id`. */
  press(id: string, menuId?: string): () => void;
}

export function createPressRelay(): PressRelay {
  let handlers = new Map<string, () => void>();
  const stable = new Map<string, () => void>();
  return {
    update(actions) {
      const next = new Map<string, () => void>();
      for (const a of actions) {
        next.set(a.id, a.onPress);
        for (const item of a.menu ?? []) next.set(`${a.id}/${item.id}`, item.onPress);
      }
      handlers = next;
    },
    press(id, menuId) {
      const key = menuId === undefined ? id : `${id}/${menuId}`;
      let fn = stable.get(key);
      if (!fn) {
        fn = () => handlers.get(key)?.();
        stable.set(key, fn);
      }
      return fn;
    },
  };
}
