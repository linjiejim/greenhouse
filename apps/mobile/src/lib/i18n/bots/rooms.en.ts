/**
 * Conversations with other people (`bots.room` — rooms, spec 20261011-agent-first-class P5) — English,
 * the key source: the drawer's People section, the thread of a room, its ⋯ menu and the sheet that
 * starts one (app/bots/new-room.tsx).
 */

export const botsRoomsEn = {
  room: {
    /** The drawer section between the main thread and the Agents. */
    section: 'People',
    /** The drawer's way to start one (the People section's last row; the ✎ button's long press). */
    newRoom: 'New Conversation With People',
    newRoomShort: 'With People…',
    newRoomHint: 'Talk with teammates, and bring your Agents along',
    newChat: 'New Chat',
    /** A room everyone else left, with no title of its own. */
    untitled: 'Conversation',
    /** A private chat at rest (two people, no title, no Agents). */
    privateChat: 'Private chat',
    /** A room at rest: who is in it. */
    statusPeople: '{n} people',
    statusAlone: 'Only you',
    statusOneAgent: '{n} people · 1 Agent',
    statusAgents: '{n} people · {m} Agents',
    /** An Agent someone else brought that this member's directory doesn't know: its owner names it. */
    agentOf: '{name}’s Agent',
    someAgent: 'An Agent',
    /** A message's author who has left the room. */
    someone: 'Someone who left',
    /** The start of the thread. */
    privateStart: 'This is the beginning of your private chat with {name}.',
    groupStart:
      'Everyone here sees every message. An Agent answers only when someone who may use it @-mentions it — your own Agents answer only you.',
    /** The composer's `+` menu: @-mention an Agent you may ask here. */
    ask: 'Ask an Agent',
    /** ⋯ menu. */
    inRoom: 'In This Conversation',
    you: 'You',
    owner: 'Created it',
    yourAgent: 'Your Agent',
    rename: 'Rename',
    renameFailed: 'Couldn’t rename the conversation',
    addPeople: 'Add People…',
    bringAgent: 'Bring an Agent',
    removeAgent: 'Remove an Agent',
    leave: 'Leave Conversation',
    leaveTitle: 'Leave this conversation?',
    leaveMessage: 'It leaves your list, and your Agents leave with you. Everyone else keeps it.',
    leaveLast: 'You’re the last one here — leaving deletes it.',
    leaveConfirm: 'Leave',
    left: 'You left the conversation',
    leaveFailed: 'Couldn’t leave the conversation',
    /** 409 `busy`: their (the member's) Agent is answering right now. */
    leaveBusy: 'Your Agent is answering right now — try again in a moment.',
    agentAdded: '{name} joined',
    agentAddFailed: 'Couldn’t bring {name} in',
    /** 409 on bringing an Agent: a public one not offered to everyone here. */
    agentNotForEveryone: '{name} isn’t shared with everyone here',
    agentRemoved: '{name} left',
    agentRemoveFailed: 'Couldn’t remove {name}',
    /** The new-conversation sheet (and its "add people" form). */
    newTitle: 'New Conversation',
    addTitle: 'Add People',
    titleSection: 'Title',
    titlePlaceholder: 'Optional',
    titleFooter:
      'Without one, it’s named after the people in it. Two of you with no title and no Agents is your private chat.',
    people: 'People',
    agents: 'Your Agents',
    agentsFooter: 'An Agent answers here only when you @-mention it, and works for you — with your access.',
    noPeople: 'No One to Add',
    noPeopleHint: 'Only teammates with Agents turned on can join a conversation.',
    everyoneIn: 'Everyone’s Already Here',
    noMatch: 'No Results',
    loadFailed: 'Couldn’t Load People',
    missing: 'Not Available on This Server',
    missingHint: 'This server doesn’t have conversations with people yet.',
    start: 'Start',
    add: 'Add',
    createFailed: 'Couldn’t start the conversation',
    addFailed: 'Couldn’t add {name}',
    /** 409 `room_full` and other refusals carry the server's sentence. */
    full: 'This conversation is full',
    picked: '{n} selected',
  },
};
