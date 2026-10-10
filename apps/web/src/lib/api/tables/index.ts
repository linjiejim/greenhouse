/**
 * Typed Tables API client, one module per domain. Import from here
 * (`lib/api/tables`); each slice adds functions to its own module only.
 *
 * Calls go through the hc `rpc` client wherever the route is typed through the
 * chain; raw `authFetch` remains only where it was before the split.
 */

export * from './access';
export * from './activity';
export * from './automations';
export * from './bases';
export * from './dashboards';
export * from './forms';
export * from './imports';
export * from './members';
export * from './plan';
export * from './records';
export * from './schema';
export * from './views';
