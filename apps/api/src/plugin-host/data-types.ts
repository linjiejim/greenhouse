import type { ApplicationDefinition, ActorContext, EntityPolicy } from '@greenhouse/platform-kernel';
import type { CrudService, ListParams, ListResult } from '@greenhouse/crud/server';
import type { DatabaseProvider } from '@greenhouse/db';
import type { EntityAction, EntityViewSchema } from '@greenhouse/types/plugins';

export type DataRow = Record<string, unknown>;
export interface DataHandlerContext {
  db: DatabaseProvider;
  actor: ActorContext;
  policy: EntityPolicy;
  /** Already scoped to the caller; custom handlers should delegate to this service. */
  service: CrudService<DataRow> & { search(query: string, params: ListParams): Promise<ListResult<DataRow>> };
}
export interface DataEntity {
  actions: Partial<Record<EntityAction, 'team' | 'super'>>;
  audit?: 'writes' | 'all';
  ownerField?: string;
  memberField?: string;
  /** Kernel field id → physical column; omitted entries use the kernel id. */
  columns?: Record<string, string>;
  views?: EntityViewSchema[];
  peek: { title: string; subtitle?: string };
  handlers?: {
    list?: (params: ListParams, ctx: DataHandlerContext) => Promise<ListResult<DataRow>>;
    get?: (id: string, ctx: DataHandlerContext) => Promise<DataRow | null>;
    search?: (query: string, params: ListParams, ctx: DataHandlerContext) => Promise<ListResult<DataRow>>;
    export?: (params: ListParams, ctx: DataHandlerContext) => Promise<ListResult<DataRow>>;
    create?: (data: DataRow, ctx: DataHandlerContext) => Promise<DataRow>;
    update?: (id: string, data: DataRow, ctx: DataHandlerContext) => Promise<DataRow | null>;
    delete?: (id: string, ctx: DataHandlerContext) => Promise<boolean>;
  };
}
export interface ExtensionDataSource {
  app: ApplicationDefinition;
  featureFlag?: string;
  entities: Record<string, DataEntity>;
  tools?: { query?: { id: string }; mutation?: { id: string } };
  mcpGroup?: string;
}
