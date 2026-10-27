import { toolbarIcon } from './toolbar-icon';
import type { ScreenAction } from './screen-action-types';
export const screenActionIcon = (action: ScreenAction) => action.iosSymbol ?? toolbarIcon(action.icon);
