/** Public sign-in discovery (`GET /api/auth/providers`). */

type Fetcher = (path: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** One identity provider the station has configured (`GET /api/auth/providers`, public). */
export interface PublicProvider {
  id: string;
  title: string;
  /** It signs people in (some providers only bind an account). */
  login: boolean;
}

/** The station's configured identity providers; none when the answer is missing or malformed. */
export async function discoverProviders(fetcher: Fetcher): Promise<PublicProvider[]> {
  const response = await fetcher('/api/auth/providers');
  if (!response.ok) return [];
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('providers' in body)) return [];
  const list = (body as { providers: unknown }).providers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((provider: unknown) => {
    if (!provider || typeof provider !== 'object') return [];
    const { id, title, login } = provider as Record<string, unknown>;
    return typeof id === 'string' && id
      ? [{ id, title: typeof title === 'string' ? title : id, login: login === true }]
      : [];
  });
}

export async function feishuLoginAvailable(fetcher: Fetcher): Promise<boolean> {
  return (await discoverProviders(fetcher)).some((provider) => provider.id === 'feishu');
}
