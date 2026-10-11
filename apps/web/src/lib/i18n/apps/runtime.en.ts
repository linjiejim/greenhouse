/**
 * Apps · the runtime (`#/apps/<id>[/<pageId>]`): the app shell, pages, cards, record drawer.
 * Owned by slice R; spread into `apps` by ./en.ts (keys resolve as `apps.runtime.*`).
 */

export const appsRuntimeEn = {
  runtime: {
    loadFailed: 'Unable to load this app',
    notFoundTitle: 'App not available',
    notFoundDescription: 'It does not exist, is archived, or has not been shared with you.',
    invalidRoute: 'This app address is not valid.',
    backToCenter: 'All apps',
    pagesTitle: 'Pages',
    pageMissing: 'This page is not part of the app.',
    pagesUnavailableTitle: 'Pages do not render here yet',
    pagesUnavailableDescription: 'This version of Greenhouse lists the app’s pages but cannot show their cards yet.',
    notPublishedTitle: 'Not published yet',
    notPublishedDescription: 'People see this app once its first version is published.',
    managerView: 'Full access',
  },
} as const;
