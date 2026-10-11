/**
 * A Bot's background tasks as Live Activities — the app side (spec
 * docs/specs/20261010-mobile-live-activity.md §3.2). The views live in the widget extension
 * (targets/widget/BotTaskLiveActivity.swift); both share `BotTaskAttributes` (two byte-identical
 * copies). JS decides what to start / update / end (src/live-activity); this file only does it.
 *
 * Gated on iOS 17: the widget extension that draws the activity starts there.
 * `endFromPush` is the background path — a task's "done" push woke the app and
 * WidgetBridgeAppDelegate ends the activity without JS. Each such push is logged to the App
 * Group (`la-log.json`, the last 200) so dogfooding can count how often the background end worked.
 */

import ActivityKit
import Foundation

private let suiteName = "group.app.greenhouse.mobile"
private let logFile = "la-log.json"
private let logMax = 200
/** How long an ended activity stays on the lock screen when no notification already says it (D5). */
let endedActivityLinger: TimeInterval = 15 * 60

/** What JS sends to start one: the attributes, the first state, when it goes stale, its rank. */
private struct StartRequest: Decodable {
  let attributes: BotTaskAttributes
  let state: BotTaskAttributes.ContentState
  let staleAt: Double
  let relevance: Double
}

private struct StateRequest: Decodable {
  let state: BotTaskAttributes.ContentState
  let staleAt: Double?
}

/** One activity as JS sees it (`listTaskActivities`). */
private struct ActivityInfo: Encodable {
  let id: String
  let run: String
  let station: String
  let user: String
  let session: String
  let art: String
  let status: String
  let startedAt: Int
  /** Ended (it may still show on the lock screen until its dismissal time). */
  let ended: Bool
}

@available(iOS 17.0, *)
enum TaskActivities {
  static var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

  static func list() -> String {
    let infos = Activity<BotTaskAttributes>.activities.map { activity in
      ActivityInfo(
        id: activity.id,
        run: activity.attributes.run,
        station: activity.attributes.station,
        user: activity.attributes.user,
        session: activity.attributes.session,
        art: activity.attributes.art,
        status: activity.content.state.status,
        startedAt: activity.content.state.startedAt,
        ended: activity.activityState == .ended || activity.activityState == .dismissed
      )
    }
    guard let data = try? JSONEncoder().encode(infos) else { return "[]" }
    return String(data: data, encoding: .utf8) ?? "[]"
  }

  /** Start one; returns its id, or nil (Live Activities off, too many, bad JSON). */
  static func start(_ json: String) -> String? {
    guard let data = json.data(using: .utf8),
          let request = try? JSONDecoder().decode(StartRequest.self, from: data)
    else { return nil }
    let content = ActivityContent(
      state: request.state,
      staleDate: Date(timeIntervalSince1970: request.staleAt),
      relevanceScore: request.relevance
    )
    return try? Activity.request(attributes: request.attributes, content: content, pushType: nil).id
  }

  private static func find(_ id: String) -> Activity<BotTaskAttributes>? {
    Activity<BotTaskAttributes>.activities.first { $0.id == id }
  }

  static func update(id: String, json: String) async -> Bool {
    guard let activity = find(id), activity.activityState == .active,
          let data = json.data(using: .utf8),
          let request = try? JSONDecoder().decode(StateRequest.self, from: data)
    else { return false }
    let stale = request.staleAt.map { Date(timeIntervalSince1970: $0) }
    await activity.update(ActivityContent(state: request.state, staleDate: stale))
    return true
  }

  /** End one with its final state (nil: keep the last one); `dismissAt` 0 = at once. */
  static func end(id: String, json: String?, dismissAt: Double) async -> Bool {
    guard let activity = find(id) else { return false }
    var content: ActivityContent<BotTaskAttributes.ContentState>? = nil
    if let json, let data = json.data(using: .utf8),
       let request = try? JSONDecoder().decode(StateRequest.self, from: data) {
      content = ActivityContent(state: request.state, staleDate: nil)
    }
    let policy: ActivityUIDismissalPolicy =
      dismissAt <= 0 ? .immediate : .after(Date(timeIntervalSince1970: dismissAt))
    await activity.end(content, dismissalPolicy: policy)
    return true
  }

  static func endAll() async {
    for activity in Activity<BotTaskAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
    }
  }

  /** The face files every current activity points at — `pruneArt` must keep them. */
  static func artFilesInUse() -> Set<String> {
    var files = Set<String>()
    for activity in Activity<BotTaskAttributes>.activities where !activity.attributes.art.isEmpty {
      for variant in ["L", "D", "M"] { files.insert("\(activity.attributes.art)\(variant).png") }
    }
    return files
  }

  enum PushOutcome: String {
    case ended, alreadyEnded = "already_ended", notFound = "not_found"
  }

  /**
   * A task's "done" push arrived while the app was in the background: end its activity. A push
   * that also showed a notification (`alerted`) takes the activity off at once — the notification
   * says it; a silent one leaves the end state on the lock screen for a while.
   */
  static func endFromPush(_ push: TaskEndPush) async -> PushOutcome {
    let match = Activity<BotTaskAttributes>.activities.first { activity in
      activity.attributes.run == push.run && activity.attributes.user == push.user
        && (push.station == nil || activity.attributes.station == push.station)
    }
    guard let activity = match else { return .notFound }
    if activity.activityState != .active && activity.activityState != .stale { return .alreadyEnded }
    let now = Date()
    var state = activity.content.state
    state.status = push.status
    state.endedAt = Int(now.timeIntervalSince1970)
    let policy: ActivityUIDismissalPolicy =
      push.alerted ? .immediate : .after(now.addingTimeInterval(endedActivityLinger))
    await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: policy)
    return .ended
  }
}

/**
 * The part of a push the background end needs. Expo puts the push's `data` under `body`
 * (expo-notifications NotificationRecords.swift), as a dictionary or as JSON text.
 */
struct TaskEndPush {
  let run: String
  let status: String
  let user: String
  let station: String?
  let alerted: Bool

  init?(_ userInfo: [AnyHashable: Any]) {
    var data: [String: Any]? = userInfo["body"] as? [String: Any]
    if data == nil, let text = userInfo["body"] as? String, let bytes = text.data(using: .utf8) {
      data = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any]
    }
    if data == nil { data = userInfo["data"] as? [String: Any] }
    guard let data, data["k"] as? String == "done",
          let run = data["run"] as? String, !run.isEmpty,
          let status = data["st"] as? String,
          let user = data["u"] as? String
    else { return nil }
    self.run = run
    self.status = status
    self.user = user
    station = data["s"] as? String
    alerted = (userInfo["aps"] as? [String: Any])?["alert"] != nil
  }
}

/** The background end's record in the App Group: when, which run, what happened (last `logMax`). */
enum ActivityLog {
  private static var url: URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName)?
      .appendingPathComponent(logFile)
  }

  static func append(run: String, outcome: String, alerted: Bool) {
    guard let url else { return }
    var entries = (try? Data(contentsOf: url))
      .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
    entries.append([
      "at": Int(Date().timeIntervalSince1970),
      "run": run,
      "outcome": outcome,
      "alerted": alerted,
    ])
    if entries.count > logMax { entries.removeFirst(entries.count - logMax) }
    if let data = try? JSONSerialization.data(withJSONObject: entries) {
      try? data.write(to: url, options: .atomic)
    }
  }

  static func read() -> String {
    guard let url, let data = try? Data(contentsOf: url) else { return "[]" }
    return String(data: data, encoding: .utf8) ?? "[]"
  }
}
