/**
 * An Agent's background run as a Live Activity — lock screen and Dynamic Island (spec
 * docs/specs/20261010-mobile-live-activity.md §2.3, §2.4; mock docs/specs/assets/live-activity/).
 * The Swift names still say "task"; the words on screen say 运行 / run.
 *
 * The app starts, updates and ends it (src/live-activity, modules/widget-bridge); the data is
 * `BotTaskAttributes` (./BotTaskAttributes.swift) and carries no words — every string below is
 * written here, in the activity's own language (`attributes.lang`).
 *
 * - The timer is `Text(timerInterval:)`, capped at the run's 20-minute limit: the system ticks it
 *   with no updates, and it can never run past the limit.
 * - Stale (no news by `staleDate`): "may have finished", never a guess at the result.
 * - Faces are the App Group PNGs the app drew for this activity, read at their real point size
 *   (an image larger than its presentation can keep an activity from starting): 52 pt for the
 *   lock screen and the expanded island, 36 pt (dark) for compact / minimal. Missing → the
 *   Agent's initial on a tinted disc.
 * - One `widgetURL` for the whole island (several are undefined behaviour): the run's conversation,
 *   else the run itself.
 * - No title unless the device shows previews (`attributes.title`); no buttons (D12).
 */

import ActivityKit
import SwiftUI
import WidgetKit

/// The run limit (apps/api RUN_TIMEOUT_MS): the timer stops there.
private let taskLimit: TimeInterval = 20 * 60
/// The island is always black: its accent is the dark-mode one.
private let islandAccent = Color("IslandAccent")

// MARK: - State

private enum TaskPhase {
  case queued, running, needsYou, succeeded, failed, canceled, stale

  init(_ context: ActivityViewContext<BotTaskAttributes>) {
    switch context.state.status {
    case "succeeded": self = .succeeded
    case "failed": self = .failed
    case "canceled": self = .canceled
    default:
      // still going as far as we know: past its staleDate, say so instead
      if context.isStale {
        self = .stale
        return
      }
      switch context.state.status {
      case "queued": self = .queued
      case "waiting": self = .needsYou
      default: self = .running
      }
    }
  }

  var ticks: Bool { self == .queued || self == .running }
  var ended: Bool { self == .succeeded || self == .failed || self == .canceled }
}

private func startDate(_ state: BotTaskAttributes.ContentState) -> Date {
  Date(timeIntervalSince1970: TimeInterval(state.startedAt))
}

// MARK: - Words

private struct Copy {
  let zh: Bool

  init(_ attributes: BotTaskAttributes) {
    zh = attributes.lang == "zh"
  }

  func line(_ phase: TaskPhase, _ state: BotTaskAttributes.ContentState) -> String {
    switch phase {
    case .queued: return zh ? "排队中" : "Queued"
    case .running: return zh ? "后台运行中" : "Running in the background"
    case .needsYou: return zh ? "需要你" : "Needs you"
    case .succeeded:
      guard let took = duration(state) else { return zh ? "运行完成了" : "Run done" }
      return zh ? "运行完成了 · 用时 \(took)" : "Done in \(took)"
    case .failed: return zh ? "运行没能完成" : "The run didn't finish"
    case .canceled: return zh ? "运行已取消" : "Run canceled"
    case .stale: return zh ? "状态没有更新，可能已经结束" : "No update — it may have finished"
    }
  }

  /// The second line that says what a tap does, when there is something to see.
  func hint(_ phase: TaskPhase) -> String? {
    switch phase {
    case .succeeded: return zh ? "点按查看汇报" : "Tap to see the report"
    case .needsYou: return zh ? "点按去处理" : "Tap to take a look"
    case .failed: return zh ? "点按查看原因" : "Tap to see why"
    case .stale: return zh ? "打开 App 查看" : "Open the app to check"
    default: return nil
    }
  }

  var elapsed: String { zh ? "已用时" : "Elapsed" }
  var islandHint: String { zh ? "点按打开对话 · 最长 20 分钟" : "Tap to open the chat · 20 min at most" }
  var islandLine: String { zh ? "后台运行中 · 完成后会通知你" : "Running in the background · you'll be told when it's done" }

  /// "4 分 12 秒" / "4m 12s"; nil when the end is unknown.
  private func duration(_ state: BotTaskAttributes.ContentState) -> String? {
    guard let ended = state.endedAt else { return nil }
    let seconds = max(0, ended - state.startedAt)
    let h = seconds / 3600, m = (seconds % 3600) / 60, s = seconds % 60
    if h > 0 { return zh ? "\(h) 小时 \(m) 分" : "\(h)h \(m)m" }
    if m > 0 { return zh ? "\(m) 分 \(s) 秒" : "\(m)m \(s)s" }
    return zh ? "\(s) 秒" : "\(s)s"
  }
}

private func taskURL(_ attributes: BotTaskAttributes) -> URL? {
  if attributes.session.isEmpty { return URL(string: "greenhouse://runs/\(query(attributes.run))") }
  return URL(string: "greenhouse://?c=\(query(attributes.session))")
}

// MARK: - Faces

/** A face the app drew for this activity (`<art><variant>.png`), at its real point size. */
private func activityFace(_ attributes: BotTaskAttributes, variant: String, points: CGFloat) -> UIImage? {
  guard !attributes.art.isEmpty, let dir = artDirectory,
        let data = try? Data(contentsOf: dir.appendingPathComponent("\(attributes.art)\(variant).png")),
        let probe = UIImage(data: data), probe.size.width > 0
  else { return nil }
  // probe is read at scale 1 (pixels): scale it so the image measures `points`
  return UIImage(data: data, scale: max(1, probe.size.width / points))
}

private struct Face: View {
  let attributes: BotTaskAttributes
  /// "L" light 52 pt · "D" dark 52 pt · "M" dark 36 pt.
  let variant: String
  let points: CGFloat
  let size: CGFloat
  /// Drawn on the always-dark island.
  var island = false

  var body: some View {
    Group {
      if let image = activityFace(attributes, variant: variant, points: points) {
        Image(uiImage: image).resizable().scaledToFit()
      } else {
        Circle()
          .fill(island ? Color.white.opacity(0.16) : Color("AccentTint"))
          .overlay(
            Text(String(attributes.botName.prefix(1)))
              .font(.system(size: size * 0.42, weight: .semibold))
              .foregroundStyle(island ? islandAccent : Color("$accent"))
          )
      }
    }
    .frame(width: size, height: size)
  }
}

/** The lock screen's face for the current scheme. */
private struct SchemeFace: View {
  @Environment(\.colorScheme) private var scheme
  let attributes: BotTaskAttributes
  let size: CGFloat

  var body: some View {
    Face(attributes: attributes, variant: scheme == .dark ? "D" : "L", points: 52, size: size)
  }
}

/** The end / stale mark on a face. */
private struct PhaseGlyph: View {
  let phase: TaskPhase
  let size: CGFloat

  var body: some View {
    switch phase {
    case .succeeded: glyph("checkmark.circle.fill", .green)
    case .failed: glyph("exclamationmark.circle.fill", .orange)
    case .canceled: glyph("xmark.circle.fill", .gray)
    case .needsYou: glyph("hand.raised.circle.fill", .orange)
    case .stale: glyph("clock.fill", .gray)
    default: EmptyView()
    }
  }

  private func glyph(_ name: String, _ color: Color) -> some View {
    Image(systemName: name)
      .font(.system(size: size, weight: .semibold))
      .symbolRenderingMode(.palette)
      .foregroundStyle(.white, color)
  }
}

// MARK: - Timer

private struct TaskTimer: View {
  let state: BotTaskAttributes.ContentState
  let size: CGFloat
  let color: Color

  var body: some View {
    let start = startDate(state)
    // ends at the run limit: the clock stops there by itself
    Text(timerInterval: start...start.addingTimeInterval(taskLimit), countsDown: false)
      .font(.system(size: size, weight: .semibold))
      .monospacedDigit()
      .multilineTextAlignment(.trailing)
      .foregroundStyle(color)
  }
}

// MARK: - Lock screen

private struct LockScreenView: View {
  let context: ActivityViewContext<BotTaskAttributes>

  var body: some View {
    let attributes = context.attributes
    let phase = TaskPhase(context)
    let copy = Copy(attributes)
    HStack(alignment: .center, spacing: 12) {
      SchemeFace(attributes: attributes, size: 46)
        .overlay(alignment: .bottomTrailing) {
          PhaseGlyph(phase: phase, size: 17)
            .background(Circle().fill(Color("$widgetBackground")).padding(-1.5))
            .offset(x: 4, y: 3)
        }
      VStack(alignment: .leading, spacing: 2) {
        Text(attributes.botName)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Color.primary)
          .lineLimit(1)
        if let title = attributes.title, !title.isEmpty {
          Text(title)
            .font(.system(size: 13))
            .foregroundStyle(Color.primary)
            .lineLimit(1)
            .privacySensitive()
        }
        Text(copy.line(phase, context.state))
          .font(.system(size: 13))
          .foregroundStyle(Color.secondary)
          .lineLimit(1)
        if let hint = copy.hint(phase) {
          Text(hint)
            .font(.system(size: 13))
            .foregroundStyle(Color("$accent"))
            .lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      if phase.ticks {
        VStack(alignment: .trailing, spacing: 1) {
          TaskTimer(state: context.state, size: 22, color: Color("$accent"))
            .frame(maxWidth: 84, alignment: .trailing)
          Text(copy.elapsed)
            .font(.system(size: 11))
            .foregroundStyle(Color.secondary)
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
  }
}

// MARK: - Dynamic Island

private struct IslandTrailing: View {
  let context: ActivityViewContext<BotTaskAttributes>
  let compact: Bool

  var body: some View {
    let phase = TaskPhase(context)
    if phase.ticks {
      TaskTimer(state: context.state, size: compact ? 14 : 26, color: islandAccent)
        // an unbounded timer stretches the island to its widest
        .frame(width: compact ? 44 : 84, alignment: .trailing)
    } else {
      PhaseGlyph(phase: phase, size: compact ? 18 : 26)
    }
  }
}

struct BotTaskLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: BotTaskAttributes.self) { context in
      LockScreenView(context: context)
        .activityBackgroundTint(Color("$widgetBackground"))
        .activitySystemActionForegroundColor(Color("$accent"))
        .widgetURL(taskURL(context.attributes))
    } dynamicIsland: { context in
      let copy = Copy(context.attributes)
      let phase = TaskPhase(context)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          Face(attributes: context.attributes, variant: "D", points: 52, size: 52, island: true)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          VStack(alignment: .trailing, spacing: 1) {
            IslandTrailing(context: context, compact: false)
            if phase.ticks {
              Text(copy.elapsed).font(.system(size: 11)).foregroundStyle(Color.white.opacity(0.6))
            }
          }
          .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.center) {
          VStack(alignment: .leading, spacing: 2) {
            Text(context.attributes.botName)
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(Color.white)
              .lineLimit(1)
            Text(
              phase.ticks
                ? (context.attributes.title.flatMap { $0.isEmpty ? nil : $0 } ?? copy.islandLine)
                : copy.line(phase, context.state)
            )
            .font(.system(size: 13))
            .foregroundStyle(Color.white.opacity(0.6))
            .lineLimit(2)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        DynamicIslandExpandedRegion(.bottom) {
          Text(copy.islandHint)
            .font(.system(size: 12))
            .foregroundStyle(Color.white.opacity(0.6))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 64)
        }
      } compactLeading: {
        Face(attributes: context.attributes, variant: "M", points: 36, size: 24, island: true)
      } compactTrailing: {
        IslandTrailing(context: context, compact: true)
      } minimal: {
        Face(attributes: context.attributes, variant: "M", points: 36, size: 24, island: true)
      }
      .widgetURL(taskURL(context.attributes))
      .keylineTint(islandAccent)
    }
  }
}
