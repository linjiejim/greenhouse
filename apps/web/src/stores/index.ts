/**
 * Zustand stores — barrel export.
 *
 * All global state is managed through these stores.
 * Page-level or feature-level state can remain as useState/useReducer.
 */

export { useAuthStore } from './auth-store.js';
export type { AuthState } from './auth-store.js';
export { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useUIStore } from './ui-store.js';
export { usePinStore } from './pin-store.js';
export { useProfileStore } from './profile-store.js';
export { useWsStore } from './ws-store.js';
export { useKnowledgeStore } from './knowledge-store.js';
