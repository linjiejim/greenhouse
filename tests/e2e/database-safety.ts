const UNSAFE_OVERRIDE = 'I_UNDERSTAND_E2E_IS_DESTRUCTIVE';

/** Fail before any fixture write unless E2E targets an unmistakably local test DB. */
export function assertSafeE2eDatabase(
  connectionString: string,
  override = process.env.E2E_ALLOW_UNSAFE_DATABASE,
): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }

  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  const isClearlyTestDatabase = /(?:test|e2e)/i.test(database);

  if (isLoopback && isClearlyTestDatabase) return;
  if (override === UNSAFE_OVERRIDE) return;

  throw new Error(
    `Refusing destructive E2E against ${host || '<missing-host>'}/${database || '<missing-db>'}. ` +
      'Use a loopback database whose name contains "test" or "e2e". ' +
      `Exceptional runs require E2E_ALLOW_UNSAFE_DATABASE=${UNSAFE_OVERRIDE}.`,
  );
}
