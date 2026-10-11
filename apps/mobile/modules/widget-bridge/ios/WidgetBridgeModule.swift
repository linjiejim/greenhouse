/**
 * WidgetBridge — writes the widget data snapshot (JSON string, schema owned by
 * src/widget/model.ts) into the shared App Group defaults and reloads WidgetKit
 * timelines, and keeps the avatar PNGs the snapshot points at in the App Group
 * container (`widget-art/<key>.png`). The widget's Snapshot Codable in
 * targets/widget/index.swift must stay in sync with that schema.
 *
 * It also runs a Bot's background tasks as Live Activities (./LiveActivities.swift — the
 * app's side; src/live-activity decides what to do) and ends them from a push in the
 * background (./WidgetBridgeAppDelegate.swift).
 */

import ExpoModulesCore
import WidgetKit

private let suiteName = "group.app.greenhouse.mobile"
private let snapshotKey = "widget_snapshot_v1"
private let artFolder = "widget-art"

/** Keys come from `artKey()` (src/widget/model.ts): letters and digits only — never a path. */
private func validKey(_ key: String) -> Bool {
  !key.isEmpty && key.count <= 64 && key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
}

private func artDirectory() -> URL? {
  guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: suiteName) else {
    return nil
  }
  let dir = container.appendingPathComponent(artFolder, isDirectory: true)
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

public class WidgetBridgeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WidgetBridge")

    Function("setSnapshot") { (json: String?) in
      guard let defaults = UserDefaults(suiteName: suiteName) else { return }
      if let json = json, !json.isEmpty {
        defaults.set(json, forKey: snapshotKey)
      } else {
        defaults.removeObject(forKey: snapshotKey)
      }
      WidgetCenter.shared.reloadAllTimelines()
    }

    /** Avatar files already rendered (keys without `.png`). */
    Function("listArt") { () -> [String] in
      guard let dir = artDirectory(),
            let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path)
      else { return [] }
      return names.filter { $0.hasSuffix(".png") }.map { String($0.dropLast(4)) }
    }

    /** One rendered face (base64 PNG, as react-native-svg's toDataURL hands it over). */
    Function("writeArt") { (key: String, base64: String) -> Bool in
      guard validKey(key),
            let dir = artDirectory(),
            let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
            !data.isEmpty
      else { return false }
      do {
        try data.write(to: dir.appendingPathComponent("\(key).png"), options: .atomic)
        return true
      } catch {
        return false
      }
    }

    /**
     * Drop every avatar file but `keep` (the faces the current snapshot points at) and the faces
     * of the Live Activities still around — the widget publishes (and prunes) as the app goes to
     * the background, just when an activity starts to show.
     */
    Function("pruneArt") { (keep: [String]) in
      guard let dir = artDirectory(),
            let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path)
      else { return }
      var wanted = Set(keep.map { "\($0).png" })
      if #available(iOS 17.0, *) { wanted.formUnion(TaskActivities.artFilesInUse()) }
      for name in names where !wanted.contains(name) {
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
      }
    }

    // ─── Live Activities (iOS 17+; elsewhere: unsupported, no-ops) ───

    /** {supported, enabled}: the OS can show them / the member allows them for this app. */
    Function("liveActivitiesState") { () -> [String: Bool] in
      guard #available(iOS 17.0, *) else { return ["supported": false, "enabled": false] }
      return ["supported": true, "enabled": TaskActivities.enabled]
    }

    /** JSON array of the task activities still around (ended ones too, until dismissed). */
    Function("listTaskActivities") { () -> String in
      guard #available(iOS 17.0, *) else { return "[]" }
      return TaskActivities.list()
    }

    /** JSON {attributes, state, staleAt, relevance} → the new activity's id, or nil. */
    Function("startTaskActivity") { (json: String) -> String? in
      guard #available(iOS 17.0, *) else { return nil }
      return TaskActivities.start(json)
    }

    AsyncFunction("updateTaskActivity") { (id: String, json: String) async -> Bool in
      guard #available(iOS 17.0, *) else { return false }
      return await TaskActivities.update(id: id, json: json)
    }

    /** `json` {state} or nil (keep the last state); `dismissAt` Unix seconds, 0 = at once. */
    AsyncFunction("endTaskActivity") { (id: String, json: String?, dismissAt: Double) async -> Bool in
      guard #available(iOS 17.0, *) else { return false }
      return await TaskActivities.end(id: id, json: json, dismissAt: dismissAt)
    }

    AsyncFunction("endAllTaskActivities") { () async in
      guard #available(iOS 17.0, *) else { return }
      await TaskActivities.endAll()
    }

    /** The background end's log (JSON array, oldest first) — dogfood diagnostics. */
    Function("readTaskActivityLog") { () -> String in
      ActivityLog.read()
    }
  }
}
