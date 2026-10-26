import { toolbarIcon } from './toolbar-icon.android';
import type { ScreenAction } from './screen-action-types';
export const screenActionIcon = (action: ScreenAction) => toolbarIcon(action.icon);
