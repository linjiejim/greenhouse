/**
 * Platform-agnostic HTTP client interface.
 *
 * This abstraction allows the API client layer to work across platforms:
 * - Web: uses fetch + localStorage for tokens
 * - React Native: uses fetch + AsyncStorage / SecureStore
 * - Node.js: uses fetch + env vars / file-based tokens
 *
 * Each platform provides its own implementation of this interface.
 */

// ─── Token Storage Interface ─────────────────────────────

/**
 * Abstract token storage — platform provides the implementation.
 * Web: localStorage
 * RN: @react-native-async-storage or expo-secure-store
 */
export interface TokenStorage {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setTokens(accessToken: string, refreshToken: string): void;
  clearTokens(): void;
  getCachedUser<T>(): T | null;
  setCachedUser<T>(user: T): void;
}

// ─── HTTP Client Interface ───────────────────────────────

/**
 * Authenticated HTTP client that handles token injection and refresh.
 * Platform-agnostic — only depends on the global `fetch` API.
 */
export interface HttpClient {
  /** Authenticated fetch — injects Authorization header and handles 401 refresh. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  /** Raw fetch without auth — for login/public endpoints. */
  rawFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

// ─── Configuration ───────────────────────────────────────

export interface HttpClientConfig {
  /** Base URL for API calls (e.g. 'https://api.example.com' or '' for same-origin). */
  baseUrl: string;
  /** Token storage implementation. */
  storage: TokenStorage;
  /** Called when auth fails irrecoverably (e.g. redirect to login). */
  onUnauthorized?: () => void;
  /** Refresh endpoint path (default: '/api/auth/refresh'). */
  refreshPath?: string;
}

// ─── Implementation ──────────────────────────────────────

/**
 * Create a platform-agnostic authenticated HTTP client.
 *
 * Usage:
 *   const client = createHttpClient({
 *     baseUrl: '',
 *     storage: webTokenStorage,  // or rnTokenStorage
 *     onUnauthorized: () => router.push('/login'),
 *   });
 *
 *   const res = await client.fetch('/api/sessions');
 */
export function createHttpClient(config: HttpClientConfig): HttpClient {
  const { storage, baseUrl, onUnauthorized, refreshPath = '/api/auth/refresh' } = config;

  let refreshPromise: Promise<boolean> | null = null;

  async function doRefresh(): Promise<boolean> {
    const refreshToken = storage.getRefreshToken();
    if (!refreshToken) return false;

    try {
      const res = await fetch(`${baseUrl}${refreshPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) return false;

      const data = await res.json();
      storage.setTokens(data.accessToken, data.refreshToken);
      storage.setCachedUser(data.user);
      return true;
    } catch {
      return false;
    }
  }

  function tryRefresh(): Promise<boolean> {
    if (refreshPromise) return refreshPromise;
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const token = storage.getAccessToken();
    const headers = new Headers(init?.headers);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const res = await fetch(input, { ...init, headers });

    // If 401, try refresh
    if (res.status === 401) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        const newToken = storage.getAccessToken();
        const retryHeaders = new Headers(init?.headers);
        if (newToken) retryHeaders.set('Authorization', `Bearer ${newToken}`);
        const retryRes = await fetch(input, { ...init, headers: retryHeaders });

        if (retryRes.status === 401) onUnauthorized?.();
        return retryRes;
      }
      onUnauthorized?.();
    }

    // 403 with needsAuth
    if (res.status === 403) {
      try {
        const cloned = res.clone();
        const data = await cloned.json();
        if (data.needsAuth) onUnauthorized?.();
      } catch {
        /* not JSON, ignore */
      }
    }

    return res;
  }

  return {
    fetch: authFetch,
    rawFetch: (input, init) => fetch(input, init),
  };
}
