/** Browser confirmations go through the notice stack (./notify.web.tsx). */
import type { IconName } from './core';
import { notify, NotifyHost } from './notify.web';
export function toast(message: string, _icon?: IconName) {
  notify.success(message);
}
export function ToastHost() {
  return <NotifyHost />;
}
