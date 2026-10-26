/**
 * Centralized path constants for the API app.
 *
 * All paths relative to the repository root are computed here
 * so that monorepo depth changes only need one fix.
 */

import { resolve } from 'node:path';

/** Repository root: greenhouse/ */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

/** .env file at repo root */
export const ENV_FILE = resolve(REPO_ROOT, '.env');

/** public/ directory at repo root (built frontend assets) */
export const PUBLIC_DIR = resolve(REPO_ROOT, 'public');

/** data/ directory at repo root */
export const DATA_DIR = resolve(REPO_ROOT, 'data');

/** The core migration chain (drizzle-kit's `out`). */
export const DRIZZLE_DIR = resolve(REPO_ROOT, 'drizzle');

/** data/uploads/ directory */
export const UPLOADS_DIR = resolve(DATA_DIR, 'uploads');

/** data/skills/ directory — local-disk default of the Skill Center bundle store */
export const SKILLS_DIR = resolve(DATA_DIR, 'skills');
