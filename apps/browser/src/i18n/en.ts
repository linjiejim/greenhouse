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
    chatComingSoon: 'Chat with page context lands in the next milestone — the connection is ready.',
  },
};
