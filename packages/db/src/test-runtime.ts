import type { DatabaseProvider } from './provider.js';

let activeTransactionProvider: DatabaseProvider | null = null;

export function getActiveTestTransactionProvider(): DatabaseProvider | null {
  return activeTransactionProvider;
}

export function setActiveTestTransactionProvider(provider: DatabaseProvider): void {
  if (activeTransactionProvider) {
    throw new Error('A database test transaction is already active in this worker');
  }
  activeTransactionProvider = provider;
}

export function clearActiveTestTransactionProvider(provider: DatabaseProvider): void {
  if (activeTransactionProvider === provider) activeTransactionProvider = null;
}
