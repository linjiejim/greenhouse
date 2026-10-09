/**
 * Bots copy shared across packages (`bots.common.*`) — English, the key source.
 * The `bots` namespace is split by owner (spec §2.6/§8): common · thread
 * (thread / status / stop / pending / composer) · cards (card / login / needs)
 * · nav · manage, mounted once in ../en.ts and ../zh.ts. Inside Bots the word
 * is always "Bot"; Chinese keeps "Bot" untranslated.
 */

export const botsCommonEn = {
  common: {
    needsYou: 'Needs You',
    needsYouN: 'Needs You · {n}',
    youSaid: 'You: {text}',
    noMessages: 'No messages yet',
    replying: 'Replying…',
    deletedBot: 'Deleted Bot',
    archivedSuffix: '(archived)',
  },
};
