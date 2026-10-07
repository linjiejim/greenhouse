import type { botsNavEn } from './nav.en';

export const botsNavZh: typeof botsNavEn = {
  nav: {
    section: 'Bots',
    showAll: '显示全部（{n}）',
    archived: '已归档（{n}）',
    loadFailed: 'Bots 加载失败 · 重试',
    pinnedA11y: '已置顶',
    newBot: '新建 Bot',
    custom: '自定义…',
    newGroup: '新建群聊',
    needsComputer: '需要电脑（暂不可用）',
    limitReached: '已达上限（20 个）',
    groupNeedsTwo: '至少要有 2 个 Bot',
    open: '打开',
    markRead: '标为已读',
    freshHint: '新对话从零开始；长期的事交给你的 Bots。',
    bridgeNeedsYou: '{name} 需要你',
    bridgeNew: '{name} 有新消息',
    bridgeReport: '{name} 交回了「{title}」',
    bridgeDefault: '和 {name} 继续长期对话',
    profileHint: '用 {name} 开一个新对话：从零开始，不进入你们的长期对话。',
    backTo: '回到 {name}',
    unavailable: 'Bots 暂不可用',
    archivedTitle: '已归档',
  },
};
