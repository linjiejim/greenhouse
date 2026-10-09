import type { botsNavEn } from './nav.en';

export const botsNavZh: typeof botsNavEn = {
  nav: {
    section: 'Bots',
    showAll: '显示全部（{n}）',
    archived: '已归档（{n}）',
    loadFailed: 'Bots 加载失败 · 重试',
    pinnedA11y: '已置顶',
    open: '打开',
    markRead: '标为已读',
    profileHint: '从零开始，不进入你们的长期对话',
    backTo: '回到 {name}',
    unavailable: 'Bots 暂不可用',
    archivedTitle: '已归档',
    profile: 'Bot 资料',
    untitledGroup: '群聊',
    archivedName: '{name}（已归档）',
    botSaid: '{name}：{text}',
    unread: '未读',
    unreadN: '{n} 条未读',
    lastMessage: '最后一条：{text}',
    listSep: '，',
    markReadFailed: '没能标为已读',
    menuBadgeA11y: '{n} 个对话需要你看看',
    // the archived sheet
    archivedEmpty: '没有已归档的对话',
    archivedEmptyHint: 'Bot 归档后，它的对话会留在这里，只读。',
    archivedFooter: '这里没有谁会再回复，记录仍可查看。',
    loadFailedTitle: '对话加载失败',
  },
};
