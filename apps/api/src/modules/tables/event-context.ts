import { AsyncLocalStorage } from 'node:async_hooks';
/** Carries the wake chain through service writes, including approved calls and app actions. */
export const tableEventChain = new AsyncLocalStorage<string[]>();
