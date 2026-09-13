/**
 * Shared NDJSON stream reader.
 *
 * Re-exports from shared types — canonical definition lives in types/api.ts so
 * stream parsing and the API contract cannot drift.
 */
export { readNdjsonStream } from '@greenhouse/types/api';
