import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

/**
 * Connectors (SET-03, ADM-08). A member's list holds their connections and the connectors they
 * can use; the admin's holds the installed connectors, with the catalog under the same prefix so
 * one invalidation refreshes what is installed. An admin change touches both lists.
 */
export const connectorKeys = {
  mine: ['connections', 'mine'] as const,
  admin: ['admin', 'connectors'] as const,
  catalog: ['admin', 'connectors', 'catalog'] as const,
  registry: (query: string) => ['admin', 'connectors', 'registry', query] as const,
};

export function useMyConnections() {
  return useQuery({ queryKey: connectorKeys.mine, queryFn: () => api.me.connections.list() });
}

export function useAdminConnectors() {
  return useQuery({ queryKey: connectorKeys.admin, queryFn: () => api.admin.connectors.list() });
}

export function useConnectorCatalog() {
  return useQuery({ queryKey: connectorKeys.catalog, queryFn: () => api.admin.connectors.catalog() });
}
