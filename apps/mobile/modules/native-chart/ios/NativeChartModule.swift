import ExpoModulesCore

/// Registers the SwiftUI chart view (`NativeChartView`) — the JS face is modules/native-chart/index.tsx.
public class NativeChartModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativeChart")

    View(NativeChartView.self)
  }
}
