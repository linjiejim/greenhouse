/**
 * Navigation the shell owns. The root stack starts at the tabs; everything else is pushed or
 * presented over them (app/_layout.tsx). Objects open through src/shell/open-object.ts; going
 * home uses `router.dismissTo('/')`, never `<Redirect>` or replace.
 */

import type { useRouter } from 'expo-router';

type Router = ReturnType<typeof useRouter>;

/** Back to home, dismissing pages and sheets above it. */
export function goHome(router: Router): void {
  if (router.canDismiss()) router.dismissTo('/');
  else router.navigate('/');
}
