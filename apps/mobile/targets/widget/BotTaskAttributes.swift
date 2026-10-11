// BotTaskAttributes.swift — TWO COPIES, byte-identical: apps/mobile/targets/widget/ and
// apps/mobile/modules/widget-bridge/ios/. ActivityKit pairs the app's activity with the
// extension's views by this type's name and Codable shape, so the copies must never drift: the
// root vitest (apps/mobile/src/live-activity/attributes.parity.test.ts) compares them, and their
// property names with the JSON the app sends (src/live-activity/model.ts). Spec:
// docs/specs/20261010-mobile-live-activity.md §3.1.

import ActivityKit
import Foundation

/// A Bot's background task on the lock screen and in the Dynamic Island.
struct BotTaskAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// BotTaskView.status: queued | running | waiting | succeeded | failed | canceled | interrupted.
    /// A string, not an enum: a status this build doesn't know still decodes.
    var status: String
    /// Timer origin, whole Unix seconds: started_at, else created_at.
    var startedAt: Int
    /// Terminal states only, whole Unix seconds.
    var endedAt: Int?
  }

  /// Schema version; a newer one than this build knows draws the plain layout.
  var v: Int
  /// The station (the device's own id for it, push `client_ref`) and the account it belongs to.
  var station: String
  var user: String
  /// The conversation the task reports into (where a tap goes) and its Runtime run.
  var session: String
  var run: String
  var botName: String
  var sprouty: Bool
  /// Base key of the Bot's face in the App Group: widget-art/<art>L.png / <art>D.png (52 pt, light /
  /// dark) and <art>M.png (36 pt, dark — compact and minimal); "" = none drawn, use the fallback.
  var art: String
  /// "zh" | "en" — the extension writes every word itself.
  var lang: String
  /// The task's title — only when the device shows previews (push D3), nil otherwise.
  var title: String?
}
