/**
 * Browser: a sheet is a route over the page with no native presentation or software keyboard, so
 * the next screen opens on the next tick, after the close has been routed. Phone: ./close-then.ts.
 */

export async function keyboardDown(): Promise<void> {}

export async function closeThen(close: () => void, open: () => void): Promise<void> {
  close();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  open();
}
