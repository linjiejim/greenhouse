/**
 * Runtime configuration.
 *
 * API_BASE is read from EXPO_PUBLIC_API_BASE_URL at build time. Defaults:
 * - dev (Expo web / simulator against a local backend): http://localhost:3000
 * - prod: set EXPO_PUBLIC_API_BASE_URL to your Greenhouse deployment origin.
 *
 * Requests omit workspace_id — the backend uses the user's default workspace.
 */
export const API_BASE = (process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
