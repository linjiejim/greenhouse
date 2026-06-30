/**
 * Design system constants.
 *
 * Z-index layer system (matches Tailwind classes used across the app):
 *   z-10  — sticky headers, resize handles, table thead
 *   z-20  — dropdowns, popovers
 *   z-40  — overlay backdrop (modal/panel bg)
 *   z-50  — modal/panel content, drag overlay
 *   z-[60] — nested modal (dialog inside dialog)
 */

export const Z_INDEX = {
  STICKY: 10, // sticky headers, resize handles — z-10
  DROPDOWN: 20, // dropdown menus, popovers — z-20
  OVERLAY: 40, // overlay backdrop — z-40
  MODAL: 50, // modal content, panels, drag overlays — z-50
  NESTED_MODAL: 60, // nested dialog inside dialog — z-[60]
} as const;

// ─── App-wide UI constants ───────────────────────────────

/** Maximum number of images a user can attach per message. */
export const MAX_IMAGES = 3;

/** Default session list page size for API requests. */
export const SESSION_LIST_LIMIT = 500;
