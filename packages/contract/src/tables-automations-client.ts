import type { KnowledgeHttp } from './knowledge-client.js';
import type { Page } from './common.js';
import type { Automation, AutomationInput, AutomationRun } from './tables-automations.js';
const at = (id: string) => `/api/tables/automations/${encodeURIComponent(id)}`;
export function automationsApi(http: KnowledgeHttp) {
  return {
    list: (base: string, query: { cursor?: string; limit?: number } = {}) =>
      http.get<Page<Automation>>(`/api/tables/bases/${encodeURIComponent(base)}/automations`, query),
    create: (base: string, input: AutomationInput) =>
      http.post<Automation & { webhook_secret?: string }>(
        `/api/tables/bases/${encodeURIComponent(base)}/automations`,
        input,
      ),
    update: (id: string, input: AutomationInput & { revision: number }) => http.patch<Automation>(at(id), input),
    remove: (id: string) => http.del(at(id)),
    history: (id: string, query: { cursor?: string; limit?: number } = {}) =>
      http.get<Page<AutomationRun>>(`${at(id)}/runs`, query),
    run: (id: string, record_id?: string) => http.post<{ id: string }>(`${at(id)}/run`, { record_id }),
    handoff: (id: string, input: { agent_id: string; brief: string; output_field_id?: string }) =>
      http.post<{ run_id: string }>(`/api/tables/records/${encodeURIComponent(id)}/handoff`, input),
  };
}
