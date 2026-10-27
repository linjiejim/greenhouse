/** Public sign-in discovery; API 3 stations predate the provider registry. */
export async function feishuLoginAvailable(
  mobileApi: number,
  fetcher: (path: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>,
): Promise<boolean> {
  const providers = mobileApi >= 4;
  const response = await fetcher(providers ? '/api/auth/providers' : '/api/feishu/login-available');
  if (!response.ok) return false;
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (!providers) return 'available' in body && body.available === true;
  return (
    'providers' in body &&
    Array.isArray(body.providers) &&
    body.providers.some(
      (provider: unknown) => !!provider && typeof provider === 'object' && 'id' in provider && provider.id === 'feishu',
    )
  );
}
