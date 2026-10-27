/** WeCom identity glue (plugins/wecom/api/oauth.ts): binding only; it returns to `/bindings?wecom=`. */

import type { IdentityGlue } from '../identity';

export const identity: IdentityGlue = {
  id: 'wecom',
  title: 'entry.providers.wecom',
  path: '/api/wecom',
};
