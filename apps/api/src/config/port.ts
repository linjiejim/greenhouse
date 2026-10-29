/** Keep the listener and OAuth's localhost fallback on the same port. */
export function resolveApiPort(env: NodeJS.ProcessEnv = process.env): number {
  return parseInt(env.API_PORT ?? env.PORT ?? '3000', 10);
}
