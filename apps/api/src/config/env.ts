import { config } from 'dotenv';
import { ENV_FILE } from '../paths.js';

// A leaf import evaluated before modules that validate infrastructure at load time.
config({ path: ENV_FILE });
