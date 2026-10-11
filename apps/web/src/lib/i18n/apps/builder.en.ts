/**
 * Apps · the builder (`#/apps/<id>/edit`): pages, canvas, properties, roles, audiences, publishing.
 * Owned by slice B; spread into `apps` by ./en.ts (keys resolve as `apps.builder.*`).
 */

export const appsBuilderEn = {
  builder: {
    title: 'Edit {name}',
    unavailableTitle: 'The builder is not available yet',
    unavailableDescription:
      'This version of Greenhouse cannot edit app pages, roles or audiences. The published app keeps working.',
    openApp: 'Open the app',
  },
} as const;
