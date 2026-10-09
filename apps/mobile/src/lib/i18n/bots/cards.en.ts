/** "Needs you" copy (`bots.card / login / needs`) — English, the key source. */

export const botsCardsEn = {
  card: {
    /** Status badge: pending, then one label per settled state (the web's settledLabelKey). */
    waiting: 'Waiting for You',
    allowed: 'Allowed',
    allowedAlways: 'Always Allowed',
    handedBack: 'Handed Back',
    createdShort: 'Created',
    started: 'Started',
    done: 'Done',
    declined: 'Declined',
    expired: 'Expired',
    canceled: 'Canceled',
    /** A Bot the directory has not answered for yet (never "Deleted Bot" before it has). */
    aBot: 'Your Bot',
    askAgain: 'Ask Again',
    expiresIn: 'Expires in {s}s',
    expiringNow: 'Expiring now',
    /** VoiceOver hint of a card in a transcript: it opens its sheet, the only place to decide. */
    openHint: 'Opens the card to review it and decide',
    moreChars: '…{n} more characters',
    moreFields: '{n} more fields',
    approvalTitle: '{name} needs your approval',
    allowOnce: 'Allow Once',
    allowAlways: 'Always Allow…',
    deny: 'Deny',
    alwaysTitle: 'Always fill on {site}?',
    alwaysBody: '{name} won’t ask again before using your saved sign-in on this site.',
    /** The confirm button of the "always" question. */
    alwaysConfirm: 'Always Allow',
    /** `{site}` when no detail row names the site. */
    thisSite: 'this site',
    taskTitle: '{name} wants to run a task',
    start: 'Start',
    cancel: 'Cancel',
    taskLimit: 'Too many background tasks are running (max 3)',
    createTitle: '{name} suggests a new Bot',
    create: 'Create',
    editFirst: 'Edit First',
    notNow: 'Not Now',
    created: 'Created {bot}',
    instructionsTitle: 'New instructions from {name}',
    accept: 'Accept',
    decline: 'Decline',
    diffSummary: '+{added} lines · −{removed} lines',
    /** VoiceOver for a diff line (the +/− glyphs are hidden). */
    diffAdded: 'Added: {text}',
    diffRemoved: 'Removed: {text}',
    current: 'Current',
    proposed: 'Proposed',
    /** The site is the card's first line (the lock row). No hyphenated words: they split at the hyphen when wrapped. */
    loginTitle: '{name} needs you to sign in',
    otpTitle: '{name} needs a code',
    signIn: 'Sign In…',
    /** The sign-in card's skip (zh differs from the create card's "Not Now"). */
    loginNotNow: 'Not Now',
    vaultHas: 'Saved in Passwords: {label} ({hint})',
    reissue: 'Start Over',
    handBack: 'Hand Back',
    handBackTitle: '{name} is waiting for you',
    waitingComputer: '{name} is waiting for the computer',
    captchaTitle: '{name} hit a human check',
    captchaHint: 'Do it by hand on the computer screen in the web app — or skip and {name} will try another way.',
    skip: 'Skip',
    otherTitle: '{name} needs a hand on the computer',
    otherHint: 'The computer isn’t visible on the phone: skip, or handle it on the web, then tap “I’ve Done It”.',
    finished: 'I’ve Done It',
    finishedConfirm: 'Done on the computer? {name} will carry on.',
    /** A kind this app version does not know: say so instead of rendering nothing. */
    unknownTitle: '{name} needs you',
    unknownHint: 'Open the web app to see this request.',
    /** Detail rows on the sheet / the sign-in card. */
    site: 'Site',
    page: 'Page',
    reason: 'Reason',
    /** Title of the alert when a decision was not carried out (the message says why). */
    failedTitle: 'Couldn’t Do That',
    /** One-line receipt of a settled card. */
    receipt: {
      allowed: 'Allowed · {title}',
      allowedAlways: 'Always allowed · {title}',
      started: 'Started · {title}',
      handedBack: 'Handed the computer back',
      instructions: 'New instructions accepted',
      signedIn: 'Signed in',
      signedInHost: 'Signed in · {host}',
      skipped: 'Skipped',
      skippedHost: 'Skipped · {host}',
      declined: 'Declined',
      declinedTitle: 'Declined · {title}',
      expired: 'Expired',
      expiredTitle: 'Expired · {title}',
      canceled: 'Canceled',
      canceledTitle: 'Canceled · {title}',
      done: 'Done',
    },
    /** A refused decision, by the server's code (BotRequestErrorCode); the card stays pending. */
    err: {
      page_gone: 'The page has already changed, so nothing was filled.',
      origin_mismatch:
        'The sign-in page moved to a different address, so nothing was filled — your password stays safe.',
      no_fields: 'Couldn’t find the sign-in fields on that page, so nothing was filled.',
      failed: 'That couldn’t be done. Try again, or finish it in the web app.',
      invalid: 'Those details couldn’t be used. Check them and try again.',
      limit: 'Too many background tasks are running. Try again when one finishes.',
      computer_restarted: 'The computer restarted and closed the page — ask the Bot to open it again.',
      bot_gone: 'The Bot that asked is no longer available, so this can’t continue.',
      /** 503: the computer or the password vault is down. */
      unavailable: 'The computer or the password vault isn’t available right now. Try again later.',
      /** No answer from the server (status 0). */
      network: 'Couldn’t reach the server. Check your connection and try again.',
    },
  },
  login: {
    title: 'Sign In to {host}',
    submit: 'Sign In',
    username: 'Username',
    password: 'Password',
    otp: 'Code',
    needOtp: 'Need a code?',
    saveToVault: 'Save to Passwords',
    footer: 'Used once: filled straight into the sign-in page — never kept in the chat or shown to the model.',
    /** The card is no longer waiting (settled elsewhere, expired) or was never found. */
    gone: 'This sign-in request is no longer open',
    goneHint: 'It was answered elsewhere or has expired.',
  },
  needs: {
    title: 'Needs You',
    empty: 'All caught up',
    /** A group with no title and no known member. */
    group: 'Group',
    archivedName: '{name} (archived)',
    /** VoiceOver hint on a group header. */
    openHint: 'Opens the conversation',
    /** The pending list could not be read (the counters say something is waiting). */
    loadFailed: 'Couldn’t Load',
    /** The card sheet (`/bots/request`) for a card that is gone. */
    goneTitle: 'This request is no longer available',
  },
};
