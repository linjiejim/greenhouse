/**
 * English messages for the extension. Registered into the @greenhouse/ui i18n
 * mechanism at startup (see ./setup.ts).
 */
export const en = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    settings: 'Settings',
  },

  options: {
    title: 'Greenhouse Companion',
    subtitle: 'Connect to your self-hosted Greenhouse instance.',

    // Connection card
    connection: 'Connection',
    baseUrl: 'Server URL',
    baseUrlPlaceholder: 'https://greenhouse.example.com',
    baseUrlInvalid: 'Enter a valid URL, e.g. https://greenhouse.example.com',
    connect: 'Connect',
    connecting: 'Connecting…',
    serverUnreachable: 'Could not reach a Greenhouse API at this address.',
    permissionDenied: 'Host permission was declined — the extension cannot call this server without it.',
    authDisabledHint:
      'This instance runs without authentication (dev mode). Continue without signing in is not supported yet — enable ACCESS_PASSWORD on the server.',

    // Login card
    signIn: 'Sign in',
    email: 'Email',
    password: 'Password',
    passwordHint: 'Your password is only sent to the server above and never stored by the extension.',
    signInAction: 'Sign in',
    signingIn: 'Signing in…',
    loginFailed: 'Sign-in failed. Check the email and password.',
    networkError: 'Network error — check the server URL and your connection.',

    // Connected card
    connectedTo: 'Connected to',
    signedInAs: 'Signed in as',
    signOut: 'Sign out',

    // Preferences card
    preferences: 'Preferences',
    language: 'Language',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'System',
  },

  panel: {
    notConnectedTitle: 'Not connected',
    notConnectedHint: 'Connect the extension to your Greenhouse instance to start asking with page context.',
    openSettings: 'Open settings',
    connected: 'Connected',

    // Selection context card
    currentPage: 'Current page',
    selectedChars: '{count} chars selected',
    noSelectionHint: 'Select text on the page to use it as context; otherwise only the URL and title ride along.',
    selectionPreview: 'Preview selection',
    needsAccess: 'Reading the selection needs access to this site.',
    allowSite: 'Allow this site',
    allowAllSites: 'Allow all sites',

    // Conversation
    emptyHint: 'Ask with page context, or start with a quick action.',
    summarizePage: 'Summarize this page',
    summarizePrompt: 'Summarize the key points of this page.',
    relatedKnowledge: 'Find related knowledge',
    relatedPrompt: 'Search the knowledge base for anything related to this page and summarize what we already know.',
    reasoning: 'Reasoning',
    askSelection: 'Ask about the selection…',
    askAnything: 'Ask anything…',
    send: 'Send',
    stop: 'Stop',
    newChat: 'New conversation',
    history: 'History',
    themeLight: 'Switch to light',
    themeDark: 'Switch to dark',
    noHistory: 'No conversations yet.',
    untitled: 'Untitled',

    // Browser automation confirm gate
    actionConfirmTitle: 'Assistant wants to act on this page',
    actionClick: 'Click "{target}"',
    actionType: 'Type into "{target}": {text}',
    actionAllow: 'Allow',
    actionDeny: 'Deny',
    actionAllowSession: "Allow, don't ask again this site",
    actionRiskPassword: 'This is a password field.',
    actionRiskPayment: 'This looks like a payment field.',
    actionRiskSubmit: 'This submits a form.',

    // Automation permission mode menu
    automationMode: 'Automation',
    modeAsk: 'Ask every time',
    modeAskHint: 'Confirm every click and typing action.',
    modeAuto: 'Auto',
    modeAutoHint: 'Run automatically; only confirm risky actions.',
    modeYolo: 'YOLO on this site',
    modeYoloHint: 'Run everything on {host} without asking.',
    modeYoloNoHost: 'Open a normal web page to enable.',
  },
};
