/**
 * Legacy / deep-link entry for a conversation (`greenhouse://chat/<id>`, used by
 * the iOS widget's "continue" row). Conversations live on the home surface
 * (`/?id=`, inside the drawer), so this screen only forwards there.
 *
 * It must not `<Redirect>` / `router.replace`: the root stack always has the
 * home `(drawer)` at its bottom (initialRouteName), and a replace would stack a
 * *second* `(drawer)` on top — inside whatever sheet happened to be open when
 * the link arrived. `dismissTo` pops back to the existing home instead (closing
 * any sheets / pages above it) and re-points it at the conversation; the
 * screen swaps conversations in place. All seven home params are always passed
 * (src/bots/nav.ts `openChat`) so a previous surface's values — a Bots
 * thread's `c` included — can't linger in the home route's params. A Bots
 * conversation's id lands on the conversation screen, which forwards it to
 * its thread once it sees the session's channel.
 */

import { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { openChat } from '../../src/bots/nav';

export default function ChatDeepLink() {
  const router = useRouter();
  const { id, title, ro } = useLocalSearchParams<{ id: string; title?: string; ro?: string }>();
  useEffect(() => {
    openChat(router, { id: String(id), title: title ? String(title) : '', ro: ro === '1' }, 'dismissTo');
  }, [router, id, title, ro]);
  return null;
}
