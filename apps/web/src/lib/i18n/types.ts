/** The shape a translation must have to mirror an English catalog (or one module of it): same keys, string leaves. */
export type DeepRecord<T> = { [K in keyof T]: T[K] extends Record<string, unknown> ? DeepRecord<T[K]> : string };
