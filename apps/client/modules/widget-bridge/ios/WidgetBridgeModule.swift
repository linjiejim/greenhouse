/**
 * WidgetBridge — writes the widgets' snapshot (JSON, shape owned by src/widget/model.ts) into the
 * shared App Group defaults and reloads the WidgetKit timelines. targets/widget/index.swift decodes
 * the same shape. A null snapshot (sign-out) clears it.
 */

import ExpoModulesCore
import WidgetKit

private let suiteName = "group.app.greenhouse.mobile"
private let snapshotKey = "widget_hub_snapshot_v1"

public class WidgetBridgeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("WidgetBridge")

    Function("setSnapshot") { (json: String?) in
      guard let defaults = UserDefaults(suiteName: suiteName) else { return }
      if let json = json, !json.isEmpty {
        if defaults.string(forKey: snapshotKey) == json { return }
        defaults.set(json, forKey: snapshotKey)
      } else {
        if defaults.string(forKey: snapshotKey) == nil { return }
        defaults.removeObject(forKey: snapshotKey)
      }
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
