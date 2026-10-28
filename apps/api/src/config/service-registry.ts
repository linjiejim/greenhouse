import type { ServiceDefinition } from './services.js';
export interface BillableService extends ServiceDefinition {
  isEnabled?: () => Promise<boolean>;
}
const entries = new Map<string, BillableService>();
export function registerBillableServices(services: readonly BillableService[], coreIds: readonly string[] = []): void {
  for (const service of services) {
    if (coreIds.includes(service.service) || entries.has(service.service))
      throw new Error(`Duplicate billable service ${service.service}`);
    entries.set(service.service, service);
  }
}
export function billableServices(): BillableService[] {
  return [...entries.values()];
}
