/** Guarded, serialized v2 migration entry point for Compose. */
import { applyMigrations } from '@greenhouse/db';
import { loadDatabaseUrl } from './config/index.js';

await applyMigrations(loadDatabaseUrl());
