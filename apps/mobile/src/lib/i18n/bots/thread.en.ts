/** Agent (code: bots) thread copy (`bots.thread / status / stop / pending / composer`) — English, the key source. */

export const botsThreadEn = {
  thread: {
    dmStart: '{name} remembers what you talk about here',
    /** The start of a task chat (a separate chat — its own context, apart from the main thread). */
    taskStart: 'A separate chat with {name}, with its own context — your main thread carries on elsewhere.',
    /** Under the group's title (never repeats it — titles run long). */
    groupStart: 'The start of this group',
    /** A group without a title or a known member. */
    group: 'Group',
    askedBy: 'asked by {name}',
    handoff: '{from} asked {to}: {brief}',
    handoffBare: '{from} asked {to} to take over',
    handoffA11y: '{from} handed the work to {to}: {brief}',
    /** The hand-off sheet's title (app/bots/relay.tsx). */
    handoffTitle: 'Hand-off',
    handoffHint: 'Shows the whole brief',
    newMessages: 'New Messages',
    needsYouJump: 'Needs You',
    latest: 'Latest',
    loadEarlier: 'Load Earlier Messages',
    earlierFailed: 'Couldn’t load · Tap to retry',
    retry: 'Retry',
    continue: 'Continue',
    retryMessage: 'Please try that again.',
    continueMessage: 'Please continue.',
    turnFailed: '{name} couldn’t reply',
    summarized: 'Earlier messages were summarized',
    view: 'View',
    refreshFailed: 'Couldn’t refresh · Retry',
    sendFailed: 'Couldn’t send',
    handleNowFailed: 'Couldn’t handle it now',
    notFound: 'Conversation not found',
    unavailable: 'Agents aren’t available',
    backToNewChat: 'Back to New Chat',
    /** ⋯ menu: the title; its subtitle is the Agent's name. */
    askInChat: 'New Chat',
    titleHintDm: 'Shows the Agent’s profile',
    readOnlyDm: '{name} is archived and won’t reply',
    /** An old group chat: group chats were retired. */
    readOnlyClosed: 'Group chats were retired — this one stays as a record.',
    /** Someone else's public Agent no longer offered to the member (unpublished, paused, out of its audience). */
    readOnlyShared: '{name} isn’t shared with you any more — this conversation stays readable.',
    /** The start of a DM with someone else's public Agent. */
    sharedStart: '{owner} shared {name} with you. It remembers what you talk about here — {owner} can’t read it.',
    /** `unavailable` · `daily_cap`, when the server wrote no line. */
    dailyCap: 'You’ve used today’s allowance with {name}. Try again tomorrow.',
    dailyCapBare: 'You’ve used today’s allowance. Try again tomorrow.',
    /** Rating a public Agent's reply (its owner sees the rating and the note, never the conversation). */
    rateUp: 'Good Response',
    rateDown: 'Bad Response',
    rateTitle: 'What Could Be Better?',
    rateMessage: 'Optional. {owner} sees your rating and this note — never the conversation.',
    rateSkip: 'Skip',
    rateSend: 'Send',
    rateThanks: 'Thanks for the feedback',
    rateFailed: 'Couldn’t send your feedback',
    /** The rating the reply already had, chosen again: taken back. */
    rateRemoved: 'Rating removed',
    rateRemoveFailed: 'Couldn’t remove your rating',
    nameHint: 'Give {name} a name of your own?',
    nameHintRename: 'Rename',
    nameHintKeep: 'Keep {name}',
    /** Time separators: the day part (bold) before the time. */
    today: 'Today',
    yesterday: 'Yesterday',
    task: '{title} · {elapsed}',
    taskMenu: '{title} · {status} · {elapsed}',
    /** A task's running time (src/bots/thread/task-elapsed.ts): on screen… */
    elapsed: { s: '{s}s', ms: '{m}m {s}s', hm: '{h}h {m}m' },
    /** …and spoken (VoiceOver), one unit per key, joined with a space. */
    elapsedA11y: {
      second: '{n} second',
      seconds: '{n} seconds',
      minute: '{n} minute',
      minutes: '{n} minutes',
      hour: '{n} hour',
      hours: '{n} hours',
    },
    tasksN: '{n} background tasks running',
    taskQueued: 'Queued',
    taskRunning: 'Running',
    taskWaiting: 'Waiting for you',
    cancelTask: 'Cancel Task',
    cancelTaskConfirm: 'Cancel “{title}”?',
    cancelFailed: 'Couldn’t cancel the task',
    taskCanceled: 'Canceled',
    taskReport: 'Background task · {title}',
    reportDone: 'Done',
    reportFailed: 'Failed',
    rememberedAll: 'Remembered (all Agents)',
    rememberedBot: 'Remembered (only {name})',
    memoryUndone: 'Forgotten',
    undoMemory: 'Undo',
    undoMemoryFailed: 'Couldn’t undo it',
    announceReplying: '{name} is replying',
    announceNeedsYou: '{name} needs you',
    /** Editing the last message of a task chat (the composer's accessory). */
    editing: 'Editing Your Message',
    editHint: 'Send to answer the edited message again',
    /** The `+` menu's title while editing: an edit changes the text only. */
    editNoImages: 'An edit keeps the message’s images',
    rewindFailed: 'Couldn’t answer again',
    editFailed: 'Couldn’t send the edit',
    /** Why a rewind was refused, by the server's 409 code. */
    rewindBusy: 'A reply is still running — wait for it to finish.',
    rewindNotLast: 'Only the last message can be edited or answered again.',
    rewindCards: 'Finish the sign-in or computer card first.',
    /** A line about another chat (`chat_opened` / `chat_origin`): VoiceOver hint. */
    openChatHint: 'Opens that chat',
    renameFailed: 'Couldn’t rename the chat',
  },
  status: {
    thinking: '{name} is thinking…',
    replying: '{name} is replying…',
    /** A DM: the title already names the Agent. */
    thinkingDm: 'Thinking…',
    replyingDm: 'Replying…',
    browsing: 'Browsing {host}',
    computer: 'Using the computer',
    handoff: 'Handing off…',
    working: 'Working…',
    /** A task chat at rest: its title is the chat's own, so the line names the Agent answering there. */
    taskWith: 'Chat with {name}',
    waitApproval: 'Waiting for your approval',
    waitLogin: 'Waiting for you to sign in',
    waitHandback: 'Waiting for the computer back',
    waitHuman: 'Waiting for a human check',
    waitConfirm: 'Waiting for your go-ahead',
    stopping: 'Stopping after this step…',
    stoppingNow: 'Stopping…',
    archived: 'Archived',
    /** An old group chat (group chats were retired). */
    groupClosed: 'Retired group chat',
    /** Someone else's public Agent, no longer offered to the member. */
    unavailable: 'No longer shared',
    /** At rest in a DM with someone else's public Agent: whose it is. */
    sharedBy: 'by {name}',
  },
  stop: {
    afterStep: 'Stop After This Step',
    now: 'Stop Now',
    a11yRunning: 'Stop. Stops after this step',
    a11ySoft: 'Stopping. Tap again to stop now',
    a11yHard: 'Stopping',
    hint: 'Stopping after this step · Tap again to stop now',
  },
  pending: {
    sending: 'Sending…',
    delivered: 'Delivered · after this reply',
    handleNow: 'Handle Now',
    next: 'Up next',
    notDelivered: 'Not Delivered',
    tryAgain: 'Try Again',
    delete: 'Delete',
  },
  composer: {
    placeholder: 'Message',
    placeholderDm: 'Message {name}',
    mentionA11y: 'Mention {name}',
  },
};
