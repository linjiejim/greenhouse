/**
 * Tables · the shared people / groups picker (Base sharing, form audiences,
 * automation recipients, app audiences). Spread into `tables` by ./en.ts.
 */

export const tablesPrincipalsEn = {
  principals: {
    searchPeople: 'Search people',
    people: 'People',
    groups: 'Groups',
    everyone: 'Everyone in the workspace',
    everyoneHint: 'Every internal member, including people who join later.',
    noPeople: 'No matching people',
    noGroups: 'You are not in any group yet',
    memberCount: '{count} members',
    managedBy: 'Members managed by {name}',
    selectedCount: '{count} selected',
    remove: 'Remove {name}',
    loadFailed: 'Unable to load people and groups',
  },
} as const;
