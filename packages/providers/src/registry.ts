import { IMAGE_ADAPTERS } from './image/adapters.js';
import { LLM_ADAPTERS } from './llm/adapters.js';
import { dockerAdapter } from './sandbox/docker.js';
import { e2bAdapter } from './sandbox/e2b/adapter.js';
import { SEARCH_ADAPTERS } from './search/adapters.js';
import { SPEECH_ADAPTERS } from './speech/adapters.js';
import { localAdapter } from './storage/local.js';
import { s3Adapter } from './storage/s3.js';
import type { AnyAdapter, Capability } from './types.js';

/** Every adapter compiled in. Extensions add theirs with registerAdapter at startup. */
const adapters = new Map<string, AnyAdapter>();

function keyOf(capability: Capability, kind: string) {
  return `${capability}:${kind}`;
}

export function registerAdapter(adapter: AnyAdapter): void {
  const key = keyOf(adapter.capability, adapter.kind);
  if (adapters.has(key)) throw new Error(`Adapter ${key} is already registered`);
  adapters.set(key, adapter);
}

export function getAdapter(capability: Capability, kind: string): AnyAdapter | undefined {
  return adapters.get(keyOf(capability, kind));
}

export function listAdapters(capability?: Capability): AnyAdapter[] {
  return [...adapters.values()].filter((adapter) => !capability || adapter.capability === capability);
}

for (const adapter of [
  ...LLM_ADAPTERS,
  ...SEARCH_ADAPTERS,
  ...SPEECH_ADAPTERS,
  ...IMAGE_ADAPTERS,
  localAdapter,
  s3Adapter,
  dockerAdapter,
  e2bAdapter,
] as AnyAdapter[]) {
  registerAdapter(adapter);
}
