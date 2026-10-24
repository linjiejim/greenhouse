import Charts
import ExpoModulesCore
import SwiftUI

/// One series of a bar / line chart, or the only series of a pie.
struct NativeChartSeries: Record {
  @Field var label: String = ""
  @Field var data: [Double] = []
  @Field var color: Color = .accentColor
}

/// What JS sends (modules/native-chart/index.tsx) — already validated by the shared chart parser.
final class NativeChartProps: ExpoSwiftUI.ViewProps {
  /// bar · line · pie · doughnut (a radar never comes here — Swift Charts has none).
  @Field var type: String = "bar"
  @Field var labels: [String] = []
  @Field var series: [NativeChartSeries] = []
  /// Pie / doughnut: one color per label.
  @Field var sliceColors: [Color] = []
  /// Print each bar's value above it (a few bars only).
  @Field var valueLabels: Bool = false
  /// The line under the plot until a label is tapped ("Tap a bar for its values").
  @Field var hint: String = ""
}

/// A chart block of a reply, drawn by Swift Charts: system axes, grid, legend
/// and VoiceOver audio graphs, in the app's series colors. A tap (never a drag
/// — the transcript scrolls under it) picks a label and spells its values out
/// under the plot.
struct NativeChartView: ExpoSwiftUI.View {
  @ObservedObject var props: NativeChartProps

  init(props: NativeChartProps) {
    self.props = props
  }

  var body: some View {
    if props.type == "pie" || props.type == "doughnut" {
      if #available(iOS 17.0, *) {
        PieChartBody(props: props)
      }
    } else {
      CartesianChartBody(props: props)
    }
  }
}

private struct ChartPoint: Identifiable {
  let id: Int
  let label: String
  let series: String
  let value: Double
}

private func formatValue(_ value: Double) -> String {
  if abs(value) >= 10_000 {
    return value.formatted(.number.notation(.compactName).precision(.fractionLength(0...1)))
  }
  return value.formatted(.number.precision(.fractionLength(0...2)))
}

private struct CartesianChartBody: View {
  @ObservedObject var props: NativeChartProps
  @State private var selected: String?

  private var points: [ChartPoint] {
    var out: [ChartPoint] = []
    for (s, series) in props.series.enumerated() {
      for (i, label) in props.labels.enumerated() where i < series.data.count {
        out.append(ChartPoint(id: s * 100_000 + i, label: label, series: series.label, value: series.data[i]))
      }
    }
    return out
  }

  var body: some View {
    let line = props.type == "line"
    let names = props.series.map(\.label)
    VStack(alignment: .leading, spacing: 6) {
      Chart {
        ForEach(points) { point in
          if line {
            LineMark(x: .value("Label", point.label), y: .value("Value", point.value))
              .foregroundStyle(by: .value("Series", point.series))
              .interpolationMethod(.monotone)
            PointMark(x: .value("Label", point.label), y: .value("Value", point.value))
              .foregroundStyle(by: .value("Series", point.series))
              .symbolSize(selected == point.label ? 64 : 22)
          } else {
            BarMark(x: .value("Label", point.label), y: .value("Value", point.value))
              .foregroundStyle(by: .value("Series", point.series))
              .position(by: .value("Series", point.series))
              .cornerRadius(3)
              .opacity(selected == nil || selected == point.label ? 1 : 0.35)
              .annotation(position: point.value < 0 ? .bottom : .top, spacing: 2) {
                if props.valueLabels {
                  Text(formatValue(point.value))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
              }
          }
        }
        if line, let selected {
          RuleMark(x: .value("Label", selected))
            .foregroundStyle(Color.secondary.opacity(0.35))
            .lineStyle(StrokeStyle(lineWidth: 1))
        }
      }
      .chartForegroundStyleScale(domain: names, range: props.series.map(\.color))
      .chartLegend(position: .bottom, alignment: .leading, spacing: 10)
      .chartLegend(names.count > 1 ? .visible : .hidden)
      .chartYAxis { AxisMarks(position: .leading) }
      .chartOverlay { proxy in
        GeometryReader { geo in
          Rectangle()
            .fill(.clear)
            .contentShape(Rectangle())
            .onTapGesture { location in select(at: location, proxy: proxy, geo: geo) }
        }
      }
      detail
        .frame(maxWidth: .infinity, minHeight: 18, alignment: .leading)
    }
  }

  @ViewBuilder private var detail: some View {
    if let selected, let index = props.labels.firstIndex(of: selected) {
      let values = props.series.compactMap { series -> String? in
        guard index < series.data.count else { return nil }
        let value = formatValue(series.data[index])
        return props.series.count > 1 ? "\(series.label) \(value)" : value
      }
      Text(([selected] + values).joined(separator: " · "))
        .font(.footnote)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    } else if !props.hint.isEmpty {
      Text(props.hint)
        .font(.footnote)
        .foregroundStyle(.tertiary)
        .lineLimit(1)
    }
  }

  private func select(at location: CGPoint, proxy: ChartProxy, geo: GeometryProxy) {
    let frame: CGRect
    if #available(iOS 17.0, *), let plot = proxy.plotFrame {
      frame = geo[plot]
    } else {
      frame = geo[proxy.plotAreaFrame]
    }
    let x = location.x - frame.origin.x
    let label: String? = (x >= 0 && x <= frame.width) ? proxy.value(atX: x) : nil
    let next = label == selected ? nil : label
    if next != selected {
      UISelectionFeedbackGenerator().selectionChanged()
    }
    selected = next
  }
}

private struct Slice: Identifiable {
  let id: Int
  let label: String
  let value: Double
}

@available(iOS 17.0, *)
private struct PieChartBody: View {
  @ObservedObject var props: NativeChartProps

  private var slices: [Slice] {
    let values = props.series.first?.data ?? []
    return props.labels.enumerated().compactMap { index, label in
      index < values.count && values[index] > 0 ? Slice(id: index, label: label, value: values[index]) : nil
    }
  }

  var body: some View {
    let slices = self.slices
    let total = slices.reduce(0) { $0 + $1.value }
    let colors = slices.map { $0.id < props.sliceColors.count ? props.sliceColors[$0.id] : Color.accentColor }
    Chart(slices) { slice in
      SectorMark(
        angle: .value("Value", slice.value),
        innerRadius: .ratio(props.type == "doughnut" ? 0.58 : 0),
        angularInset: 1.5
      )
      .cornerRadius(3)
      .foregroundStyle(by: .value("Label", slice.label))
      .annotation(position: .overlay) {
        // the share on slices big enough to hold it
        if total > 0 && slice.value / total >= 0.08 {
          Text((slice.value / total).formatted(.percent.precision(.fractionLength(0))))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
        }
      }
    }
    .chartForegroundStyleScale(domain: slices.map(\.label), range: colors)
    .chartLegend(position: .bottom, alignment: .center, spacing: 12)
  }
}
