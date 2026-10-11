/**
 * Tables · field settings: the select options list. Spread into `tables` by
 * ./en.ts (keys resolve as `tables.fieldOptions.*`).
 */

export const tablesFieldsEn = {
  fieldOptions: {
    title: 'Options',
    hint: 'Rename, reorder or remove options here; records keep pointing at the same option.',
    label: 'Option {index}',
    add: 'Add option',
    moveUp: 'Move {name} up',
    moveDown: 'Move {name} down',
    remove: 'Remove {name}',
  },
} as const;
