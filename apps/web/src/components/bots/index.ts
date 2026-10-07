/**
 * Bots — the personal assistant workspace (`#/bots`). Page-level pieces; the
 * computer pane and the vault UI live beside these files (computer-*,
 * vault-*). Design: docs/specs/20261005-personal-assistant-bots.md §9.
 */

export {
  useBotsStore,
  botsById,
  computerReady,
  conversationReplyable,
  ensureSprouty,
  useBotDirectory,
  useBotsLoadState,
  type BotsDialog,
} from './bots-store';
export { BotsBareHeader, BotsMobileNavButton } from './conversation-header';
export { useBotsSync } from './use-bots-sync';
export { useBotConversation, type BotConversationController } from './use-bot-conversation';
export { BotsSidebarPanel } from './bots-sidebar-panel';
export { ConversationView } from './conversation-view';
export { BotsSidePanel, PanelSection, useSplitCapable } from './bots-side-panel';
export { InfoPanel } from './info-panel';
export { BotProfileDrawer } from './bot-profile-drawer';
export { NewBotDialog, type CreateTab } from './new-bot-dialog';
export { NewGroupPanel } from './new-group-dialog';
export { BotsDialogs } from './bots-dialogs';
export { InviteDialog } from './invite-dialog';
export { BotAvatar, BotAvatarStack } from './bot-avatar';
export {
  conversationTitle,
  openBotsConversation,
  openChatWith,
  botsConversationHash,
  useCurrentBotsConversation,
} from './navigation';
export { buildTranscript, speakingSegment, type PendingSend, type TranscriptItem } from './transcript';
export { parseMentions } from './mentions';
