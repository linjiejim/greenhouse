/**
 * WidgetBridge — writes the widget data snapshot (JSON string, schema owned by
 * src/lib/widget-snapshot.ts) into the shared App Group defaults and reloads
 * WidgetKit timelines. The widget's Snapshot Codable in targets/widget/index.swift
 * must stay in sync with that schema.
 */

import ExpoModulesCore
import WidgetKit

private let suiteName = "group.app.greenhouse.mobile"
private let snapshotKey = "widget_snapshot_v1"

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
  }
}
