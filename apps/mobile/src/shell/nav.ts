/**
 * Navigation the shell owns. The root stack starts at the drawer (home); everything else is
 * pushed or presented over it (app/_layout.tsx). Push taps and list rows open a notification with
 * `openNotification`; going home uses `router.dismissTo('/')`, never `<Redirect>` or replace.
 */

import type { useRouter } from 'expo-router';

type Router = ReturnType<typeof useRouter>;

/** The notification page, over whatever is on screen (a push tap from anywhere). */
export function openNotification(router: Router, id: string): void {
  router.push({ pathname: '/notification', params: { id } });
}

/** Back to home, dismissing pages and sheets above it. */
export function goHome(router: Router): void {
  if (router.canDismiss()) router.dismissTo('/');
}
