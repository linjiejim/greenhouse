import table from './shortcuts.json';
/** This JSON is also compiled into the native menu; do not maintain a second table. */
export const SHORTCUTS = Object.fromEntries(table.map((row) => [row.id, row.shortcut]));
export { table as shortcutTable };
