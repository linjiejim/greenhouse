/**
 * WidgetBridge — writes the widget data snapshot (JSON string, schema owned by
 * src/widget/model.ts) into the shared App Group defaults and reloads WidgetKit
 * timelines, and keeps the avatar PNGs the snapshot points at in the App Group
 * container (`widget-art/<key>.png`). The widget's Snapshot Codable in
 * targets/widget/index.swift must stay in sync with that schema.
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

    /** Drop every avatar file but `keep` (the faces the current snapshot points at). */
    Function("pruneArt") { (keep: [String]) in
      guard let dir = artDirectory(),
            let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path)
      else { return }
      let wanted = Set(keep.map { "\($0).png" })
      for name in names where !wanted.contains(name) {
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
      }
    }
  }
}
