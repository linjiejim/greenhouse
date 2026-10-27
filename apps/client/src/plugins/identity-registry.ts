/** Official identity glue is owned by each plugin; the host only lists it (see ./identity.ts). */
import type { IdentityGlue } from './identity';
import { identity as feishu } from './feishu';
import { identity as wecom } from './wecom';

export const identityGlue: readonly IdentityGlue[] = [feishu, wecom];
