/**
 * Android navigation-bar icons: expo-router's Compose toolbar draws an image
 * source, not an SF Symbol name. Every semantic `IconName` maps to the vector
 * drawable of its Material Symbol (assets/icons/android, generated from the
 * font expo-symbols draws in-content icons with by `scripts/android-icons.py`),
 * so toolbar and content icons match. The table is generated from
 * src/ui/core.tsx `ICONS`: re-run `scripts/android-icons.py` after adding one.
 */
import type { ImageSourcePropType } from 'react-native';
import type { IconName } from './core';

/* eslint-disable @typescript-eslint/no-require-imports -- static asset table */
const SOURCES: Record<IconName, ImageSourcePropType> = {
  mic: require('../../assets/icons/android/mic.xml'),
  speaker: require('../../assets/icons/android/volume_up.xml'),
  plus: require('../../assets/icons/android/add.xml'),
  up: require('../../assets/icons/android/arrow_upward.xml'),
  stop: require('../../assets/icons/android/stop.xml'),
  search: require('../../assets/icons/android/search.xml'),
  chevR: require('../../assets/icons/android/chevron_right.xml'),
  chevD: require('../../assets/icons/android/expand_more.xml'),
  chevUpDown: require('../../assets/icons/android/unfold_more.xml'),
  check: require('../../assets/icons/android/check.xml'),
  x: require('../../assets/icons/android/close.xml'),
  book: require('../../assets/icons/android/menu_book.xml'),
  globe: require('../../assets/icons/android/public.xml'),
  file: require('../../assets/icons/android/description.xml'),
  bar: require('../../assets/icons/android/bar_chart.xml'),
  checkCircle: require('../../assets/icons/android/check_circle.xml'),
  checkCircleFill: require('../../assets/icons/android/check_circle.xml'),
  pen: require('../../assets/icons/android/edit.xml'),
  compose: require('../../assets/icons/android/edit_square.xml'),
  copy: require('../../assets/icons/android/content_copy.xml'),
  refresh: require('../../assets/icons/android/refresh.xml'),
  share: require('../../assets/icons/android/share.xml'),
  sparkle: require('../../assets/icons/android/auto_awesome.xml'),
  msg: require('../../assets/icons/android/chat_bubble.xml'),
  msgs: require('../../assets/icons/android/forum.xml'),
  folder: require('../../assets/icons/android/folder.xml'),
  gear: require('../../assets/icons/android/settings.xml'),
  menu: require('../../assets/icons/android/menu.xml'),
  expand: require('../../assets/icons/android/open_in_full.xml'),
  rotate: require('../../assets/icons/android/undo.xml'),
  clock: require('../../assets/icons/android/schedule.xml'),
  camera: require('../../assets/icons/android/photo_camera.xml'),
  image: require('../../assets/icons/android/image.xml'),
  photos: require('../../assets/icons/android/image.xml'),
  arrowDown: require('../../assets/icons/android/arrow_downward.xml'),
  quote: require('../../assets/icons/android/format_quote.xml'),
  trash: require('../../assets/icons/android/delete.xml'),
  alert: require('../../assets/icons/android/warning.xml'),
  archive: require('../../assets/icons/android/archive.xml'),
  download: require('../../assets/icons/android/download.xml'),
  users: require('../../assets/icons/android/group.xml'),
  userPlus: require('../../assets/icons/android/person_add.xml'),
  person: require('../../assets/icons/android/account_circle.xml'),
  circle: require('../../assets/icons/android/circle.xml'),
  filter: require('../../assets/icons/android/filter_list.xml'),
  filterOn: require('../../assets/icons/android/filter_alt.xml'),
  more: require('../../assets/icons/android/more_vert.xml'),
  link: require('../../assets/icons/android/link.xml'),
  server: require('../../assets/icons/android/dns.xml'),
  logout: require('../../assets/icons/android/logout.xml'),
  open: require('../../assets/icons/android/open_in_new.xml'),
  table: require('../../assets/icons/android/table.xml'),
  wrench: require('../../assets/icons/android/build.xml'),
  statusProgress: require('../../assets/icons/android/contrast.xml'),
  statusCancelled: require('../../assets/icons/android/cancel.xml'),
  personMinus: require('../../assets/icons/android/person_remove.xml'),
  comment: require('../../assets/icons/android/comment.xml'),
  hourglass: require('../../assets/icons/android/hourglass_empty.xml'),
  send: require('../../assets/icons/android/send.xml'),
  form: require('../../assets/icons/android/assignment.xml'),
  branch: require('../../assets/icons/android/call_split.xml'),
  code: require('../../assets/icons/android/code.xml'),
  diagram: require('../../assets/icons/android/account_tree.xml'),
  attach: require('../../assets/icons/android/attach_file.xml'),
  pin: require('../../assets/icons/android/push_pin.xml'),
  pinOff: require('../../assets/icons/android/keep_off.xml'),
  hand: require('../../assets/icons/android/front_hand.xml'),
  shieldCheck: require('../../assets/icons/android/verified_user.xml'),
  key: require('../../assets/icons/android/key.xml'),
  sleep: require('../../assets/icons/android/bedtime.xml'),
  at: require('../../assets/icons/android/alternate_email.xml'),
  alertCircle: require('../../assets/icons/android/error.xml'),
  thumbUp: require('../../assets/icons/android/thumb_up.xml'),
  thumbUpFill: require('../../assets/icons/android/thumb_up.xml'),
  thumbDown: require('../../assets/icons/android/thumb_down.xml'),
  thumbDownFill: require('../../assets/icons/android/thumb_down.xml'),
  computer: require('../../assets/icons/android/computer.xml'),
  keyboard: require('../../assets/icons/android/keyboard.xml'),
  zoomIn: require('../../assets/icons/android/zoom_in.xml'),
  zoomOut: require('../../assets/icons/android/zoom_out.xml'),
  bell: require('../../assets/icons/android/notifications.xml'),
  bellBadge: require('../../assets/icons/android/notifications_unread.xml'),
  bellSlash: require('../../assets/icons/android/notifications_off.xml'),
  runs: require('../../assets/icons/android/vital_signs.xml'),
  wand: require('../../assets/icons/android/auto_fix_high.xml'),
};
/* eslint-enable @typescript-eslint/no-require-imports */

export function toolbarIcon(name: IconName): ImageSourcePropType {
  return SOURCES[name];
}

/** A bar's overflow menu and its actions in platform order — Android: `⋮` ends the bar (Material). */
export function overflowLast<T>(overflow: T, ...actions: T[]): T[] {
  return [...actions, overflow];
}
