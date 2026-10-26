/** Layout widths are CSS pixels and shared with the browser's regression tests. */
export const RAIL_WIDTH = 72;
export const SECONDARY_WIDTH = 264;
export const INSPECTOR_WIDTH = 400;
export function wideLayout(width: number) {
  return { wide: width >= 760, collapseSecondary: width < 1100, floatInspector: width < 1440 };
}
