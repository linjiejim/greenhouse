/**
 * Keeping a conversation pinned to its end. React-free (./follow-end.test.ts). The list stays at
 * the bottom through every later layout change — a new message, the reply streaming in, images
 * loading, rows re-measured — as long as the member was at the bottom. It lets go when they
 * scroll up, and never moves for older history coming in at the top.
 */

/** Whether a scroll position is at the end of the content, within `slack` points. */
export function atEnd(position: { offsetY: number; viewportHeight: number; contentHeight: number }, slack = 80): boolean {
  return position.contentHeight - (position.offsetY + position.viewportHeight) <= slack;
}

/** Whether a content-size change should scroll to the end. */
export function shouldFollowEnd(change: {
  /** The member was at the end before this change. */
  pinned: boolean;
  head: string;
  prevHead: string;
  tail: string;
  prevTail: string;
}): boolean {
  if (!change.pinned) return false;
  // history came in at the top and nothing changed at the end: keep the place being read
  return !(change.head !== change.prevHead && change.tail === change.prevTail);
}
