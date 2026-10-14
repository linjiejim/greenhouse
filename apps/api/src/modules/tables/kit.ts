/**
 * What the parts of the 表格 module share (forms.ts, imports.ts, cards.ts, computed.ts…): the
 * services it was made with, the records part that writes records, the background worker, and
 * how to tell the people of a base that something changed. service.ts makes one and hands it on.
 */

import type { BaseRow } from '@greenhouse/db';
import type { Hub } from '../../realtime/hub.js';
import type { ProvidersService } from '../../providers/service.js';
import type { FilesService } from '../files/service.js';
import type { NotificationsService } from '../notifications/service.js';
import type { RecordsPart } from './records.js';
import type { TablesWorker } from './worker.js';

export interface TablesKit {
  files: FilesService;
  notifications: NotificationsService;
  hub: Hub;
  providers: ProvidersService;
  records: RecordsPart;
  worker: TablesWorker;
  /** Everyone who sees the base now (cached for a few seconds). */
  audience(base: Pick<BaseRow, 'id' | 'ownerId'>): Promise<string[]>;
  /** The base's structure, views, forms or shares changed: they refetch it (only `to` when it is theirs alone). */
  baseChanged(base: Pick<BaseRow, 'id' | 'ownerId'>, to?: string): Promise<void>;
  /** The base was written to: its updated time moves. */
  touch(baseId: string): Promise<void>;
}
