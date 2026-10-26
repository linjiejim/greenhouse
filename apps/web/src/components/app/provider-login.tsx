import React, { useEffect, useState } from 'react';
import { publicLoginProviders } from '../../extensions';
import { apiUrl } from '../../lib/api-base';
import type { AuthenticatedUser } from '../../lib/auth';
/** Pre-login discovery must not require the authenticated extensions store. */
export function PublicProviderLogin(props: {
  onSuccess: (user: AuthenticatedUser) => void;
  onError: (message: string) => void;
}) {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void fetch(apiUrl('/api/auth/providers'))
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { providers: Array<{ id: string; login: boolean }> };
        if (alive) setIds(data.providers.filter((p) => p.login).map((p) => p.id));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return (
    <>
      {publicLoginProviders(new Set(ids)).map(({ id, login: Login }) => (Login ? <Login key={id} {...props} /> : null))}
    </>
  );
}
