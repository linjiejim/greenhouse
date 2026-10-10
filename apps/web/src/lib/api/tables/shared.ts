/**
 * Helpers shared by the Tables client modules. Not re-exported from the barrel.
 */

export async function responseError(response: Response, fallback: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error || fallback);
}
