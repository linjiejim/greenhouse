/**
 * The placeholder lines the server persists for a Bot turn that wrote no text
 * (apps/api/src/bots/engine/copy.ts — `waitingForMember`, `workedWithoutText`,
 * `handedOver`; turn.ts `emptyTextFallback`): "Over to you — see the card
 * above", "(Done — see the steps above.)", "(Handed over to Fern.)". They
 * point at what is right above — the card, the tool steps, the hand-off strip
 * — so with the tool steps hidden (the default) the thread leaves them out:
 * the card and the strip already say it, and "the steps above" would point at
 * nothing. They stay the conversation's preview in the drawer.
 *
 * Pinned to the server's wording by ./filler.test.ts (it reads copy.ts).
 */

const EXACT = new Set([
  '轮到你了：请看上面的卡片。',
  'Over to you — see the card above.',
  '（已完成上面的步骤）',
  '(Done — see the steps above.)',
]);

const HANDED_OVER = [/^（已交给 .+）$/u, /^\(Handed over to .+\.\)$/u];

export function isFillerReply(text: string): boolean {
  const line = text.trim();
  return EXACT.has(line) || HANDED_OVER.some((re) => re.test(line));
}
