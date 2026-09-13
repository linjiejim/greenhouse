/**
 * Resolve the logged-in team/super access token used by HTTP-based CLI commands.
 *
 * CLI calls intentionally pass through the same database-backed authentication
 * boundary as the Web app. There is no synthetic service-user bypass.
 */
export function requireCliAccessToken(): string {
  const token = process.env.GREENHOUSE_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'GREENHOUSE_ACCESS_TOKEN is required. Log in with a team/super account and export its access token before running this command.',
    );
  }
  return token;
}
