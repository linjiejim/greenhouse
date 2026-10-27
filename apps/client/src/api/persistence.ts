import * as SecureStore from 'expo-secure-store';
export async function persistGet(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}
export function persistSet(key: string, value: string | null): void {
  try {
    if (value == null) void SecureStore.deleteItemAsync(key).catch(() => undefined);
    else void SecureStore.setItemAsync(key, value).catch(() => undefined);
  } catch {
    /* best effort */
  }
}
