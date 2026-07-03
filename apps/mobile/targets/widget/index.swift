/**
 * Greenhouse widget (v2) — launcher shortcuts + data snapshot:
 *   · systemSmall          greeting + Sprouty (time-of-day expression) → compose
 *   · systemMedium         greeting + scheduled-task rows + [新对话] [知识库]
 *   · systemLarge          tasks + recent sessions (deep link to resume) + pills
 *   · accessoryRectangular latest task result one-liner (lock screen)
 *   · accessoryCircular    Sprouty → compose (lock screen)
 *
 * Data comes from the App Group snapshot written by modules/widget-bridge —
 * `Snapshot` below decodes the JSON whose SCHEMA TRUTH lives in
 * src/lib/widget-snapshot.ts (bump SNAPSHOT_VERSION together). No snapshot
 * (logged out / never opened) degrades every family to launcher-only mode.
 *
 * Deep links ride the `greenhouse://` scheme (expo-router): `?compose=1`
 * autofocuses the home composer, `knowledge` opens the knowledge list,
 * `chat/<id>` resumes a conversation. Strings mirror src/lib/i18n; language
 * follows the snapshot's app preference, falling back to the system locale.
 */

import WidgetKit
import SwiftUI

// MARK: - App Group snapshot (schema: src/lib/widget-snapshot.ts)

private let appGroup = "group.app.greenhouse.mobile"
private let snapshotKey = "widget_snapshot_v1"
private let supportedSnapshotVersion = 1

struct SnapshotTask: Decodable {
  let name: String
  let lastStatus: String?
  let lastRunAt: Double?
  let nextRunAt: Double?
}
struct SnapshotSession: Decodable {
  let id: String
  let title: String
  let updatedAt: Double?
}
struct Snapshot: Decodable {
  let v: Int
  let updatedAt: Double
  let nickname: String
  let lang: String
  let tasks: [SnapshotTask]
  let sessions: [SnapshotSession]
}

private func loadSnapshot() -> Snapshot? {
  guard let json = UserDefaults(suiteName: appGroup)?.string(forKey: snapshotKey),
        let data = json.data(using: .utf8),
        let snap = try? JSONDecoder().decode(Snapshot.self, from: data),
        snap.v <= supportedSnapshotVersion
  else { return nil }
  return snap
}

// MARK: - i18n (app pref via snapshot; system locale as fallback)

private let systemZh = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false

private func isZh(_ snap: Snapshot?) -> Bool {
  guard let lang = snap?.lang else { return systemZh }
  return lang == "zh"
}

private func greetingText(for date: Date, zh: Bool) -> String {
  let h = Calendar.current.component(.hour, from: date)
  switch h {
  case ..<6: return zh ? "凌晨好" : "Good early morning"
  case ..<12: return zh ? "上午好" : "Good morning"
  case ..<14: return zh ? "中午好" : "Good noon"
  case ..<18: return zh ? "下午好" : "Good afternoon"
  default: return zh ? "晚上好" : "Good evening"
  }
}

/** Sprouty expression by time of day (late night sleeps). */
private func sproutyImage(for date: Date) -> String {
  let h = Calendar.current.component(.hour, from: date)
  return (h < 6 || h >= 22) ? "sproutySleep" : "sprouty"
}

// MARK: - Time formatting

private func hm(_ ms: Double, zh: Bool) -> String {
  let f = DateFormatter()
  f.locale = Locale(identifier: zh ? "zh_CN" : "en_US")
  f.dateFormat = "HH:mm"
  return f.string(from: Date(timeIntervalSince1970: ms / 1000))
}

private func nextRunText(_ ms: Double, zh: Bool) -> String {
  let date = Date(timeIntervalSince1970: ms / 1000)
  let f = DateFormatter()
  f.locale = Locale(identifier: zh ? "zh_CN" : "en_US")
  if Calendar.current.isDateInToday(date) {
    f.dateFormat = "HH:mm"
    return (zh ? "今天 " : "Today ") + f.string(from: date)
  }
  f.dateFormat = "EEE HH:mm"
  return f.string(from: date)
}

private func relativeText(_ ms: Double, zh: Bool) -> String {
  let f = RelativeDateTimeFormatter()
  f.locale = Locale(identifier: zh ? "zh_CN" : "en_US")
  f.unitsStyle = .short
  return f.localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date())
}

// MARK: - Task presentation

private struct TaskLine {
  let icon: String
  let color: Color
  let name: String
  let detail: String
}

private func taskLine(_ t: SnapshotTask, zh: Bool) -> TaskLine {
  if t.lastStatus == "running" {
    return TaskLine(icon: "arrow.triangle.2.circlepath", color: Color("$accent"), name: t.name, detail: zh ? "运行中" : "Running")
  }
  if t.lastStatus == "failed", let at = t.lastRunAt {
    return TaskLine(icon: "exclamationmark.circle.fill", color: Color("StatusDanger"), name: t.name, detail: hm(at, zh: zh) + (zh ? " 失败" : " failed"))
  }
  if t.lastStatus == "completed", let at = t.lastRunAt {
    return TaskLine(icon: "checkmark.circle.fill", color: Color("StatusSuccess"), name: t.name, detail: hm(at, zh: zh) + (zh ? " 完成" : " done"))
  }
  if let next = t.nextRunAt {
    return TaskLine(icon: "clock", color: Color("WidgetMuted"), name: t.name, detail: (zh ? "下次 " : "Next ") + nextRunText(next, zh: zh))
  }
  return TaskLine(icon: "clock", color: Color("WidgetMuted"), name: t.name, detail: zh ? "未运行" : "Not run yet")
}

// MARK: - Deep links (routes in apps/mobile/app/)

private let composeURL = URL(string: "greenhouse://?compose=1")!
private let knowledgeURL = URL(string: "greenhouse://knowledge")!
private func chatURL(_ id: String) -> URL {
  URL(string: "greenhouse://chat/\(id)") ?? composeURL
}

// MARK: - Timeline (hourly keeps greeting/expression/relative times current)

struct LauncherEntry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?
}

struct LauncherProvider: TimelineProvider {
  func placeholder(in context: Context) -> LauncherEntry { LauncherEntry(date: Date(), snapshot: nil) }

  func getSnapshot(in context: Context, completion: @escaping (LauncherEntry) -> Void) {
    completion(LauncherEntry(date: Date(), snapshot: loadSnapshot()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<LauncherEntry>) -> Void) {
    let next = Calendar.current.date(byAdding: .hour, value: 1, to: Date()) ?? Date().addingTimeInterval(3600)
    completion(Timeline(entries: [LauncherEntry(date: Date(), snapshot: loadSnapshot())], policy: .after(next)))
  }
}

// MARK: - Shared pieces

private struct AccentPill: View {
  let icon: String
  let label: String

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: icon).font(.system(size: 11, weight: .semibold))
      Text(label).font(.system(size: 12, weight: .semibold))
    }
    .foregroundStyle(Color("OnAccent"))
    .padding(.vertical, 7)
    .padding(.horizontal, 12)
    .background(Capsule().fill(Color("$accent")))
  }
}

private struct TintPill: View {
  let icon: String
  let label: String

  var body: some View {
    HStack(spacing: 4) {
      Image(systemName: icon).font(.system(size: 11, weight: .semibold))
      Text(label).font(.system(size: 12, weight: .semibold))
    }
    .foregroundStyle(Color("$accent"))
    .padding(.vertical, 7)
    .padding(.horizontal, 12)
    .background(
      Capsule()
        .fill(Color("AccentTint"))
        .overlay(Capsule().strokeBorder(Color("AccentBorder"), lineWidth: 1))
    )
  }
}

private struct LauncherPills: View {
  let zh: Bool

  var body: some View {
    HStack(spacing: 8) {
      Link(destination: composeURL) {
        AccentPill(icon: "plus", label: zh ? "新对话" : "New chat")
      }
      Link(destination: knowledgeURL) {
        TintPill(icon: "book", label: zh ? "知识库" : "Knowledge")
      }
    }
  }
}

private struct TaskRow: View {
  let line: TaskLine

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: line.icon).font(.system(size: 12, weight: .semibold)).foregroundStyle(line.color)
      Text(line.name).font(.system(size: 12, weight: .medium)).foregroundStyle(Color("WidgetFg")).lineLimit(1)
      Spacer(minLength: 4)
      Text(line.detail).font(.system(size: 11)).foregroundStyle(Color("WidgetMuted")).lineLimit(1)
    }
  }
}

// MARK: - Families

private struct SmallLauncher: View {
  let entry: LauncherEntry

  var body: some View {
    let zh = isZh(entry.snapshot)
    VStack(spacing: 6) {
      Text(greetingText(for: entry.date, zh: zh))
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Color("WidgetMuted"))
        .frame(maxWidth: .infinity, alignment: .leading)
      Image(sproutyImage(for: entry.date))
        .resizable()
        .scaledToFit()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      Text(zh ? "新对话" : "New chat")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Color("OnAccent"))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(Capsule().fill(Color("$accent")))
    }
    .containerBackground(Color("$widgetBackground"), for: .widget)
    .widgetURL(composeURL)
  }
}

private struct MediumLauncher: View {
  let entry: LauncherEntry

  var body: some View {
    let zh = isZh(entry.snapshot)
    let tasks = entry.snapshot?.tasks ?? []
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(sproutyImage(for: entry.date)).resizable().scaledToFit().frame(width: 30, height: 30)
        Text(greetingText(for: entry.date, zh: zh) + greetingName(entry.snapshot, zh: zh))
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(Color("WidgetFg"))
          .lineLimit(1)
        Spacer(minLength: 4)
        if let snap = entry.snapshot {
          Text(hm(snap.updatedAt, zh: zh) + (zh ? " 更新" : ""))
            .font(.system(size: 10))
            .foregroundStyle(Color("WidgetMuted"))
        }
      }
      if tasks.isEmpty {
        Text(zh ? "今天想做点什么？" : "What shall we do today?")
          .font(.system(size: 15, weight: .bold))
          .foregroundStyle(Color("WidgetFg"))
          .frame(maxHeight: .infinity, alignment: .center)
      } else {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(Array(tasks.prefix(2).enumerated()), id: \.offset) { _, t in
            TaskRow(line: taskLine(t, zh: zh))
          }
        }
        .frame(maxHeight: .infinity, alignment: .center)
      }
      LauncherPills(zh: zh)
    }
    .containerBackground(Color("$widgetBackground"), for: .widget)
  }
}

private struct LargeLauncher: View {
  let entry: LauncherEntry

  var body: some View {
    let zh = isZh(entry.snapshot)
    let tasks = entry.snapshot?.tasks ?? []
    let sessions = entry.snapshot?.sessions ?? []
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Image(sproutyImage(for: entry.date)).resizable().scaledToFit().frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 1) {
          Text(greetingText(for: entry.date, zh: zh) + greetingName(entry.snapshot, zh: zh))
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Color("WidgetFg"))
            .lineLimit(1)
          if let snap = entry.snapshot {
            Text(hm(snap.updatedAt, zh: zh) + (zh ? " 更新" : " updated"))
              .font(.system(size: 10))
              .foregroundStyle(Color("WidgetMuted"))
          }
        }
        Spacer(minLength: 0)
      }

      sectionLabel(zh ? "定时任务" : "Scheduled tasks")
      if tasks.isEmpty {
        Text(zh ? "还没有定时任务" : "No scheduled tasks yet")
          .font(.system(size: 12))
          .foregroundStyle(Color("WidgetMuted"))
      } else {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(Array(tasks.prefix(3).enumerated()), id: \.offset) { _, t in
            TaskRow(line: taskLine(t, zh: zh))
          }
        }
      }

      Divider()

      sectionLabel(zh ? "继续对话" : "Continue chatting")
      if sessions.isEmpty {
        Text(zh ? "暂无最近会话" : "No recent conversations")
          .font(.system(size: 12))
          .foregroundStyle(Color("WidgetMuted"))
      } else {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(sessions.prefix(2), id: \.id) { s in
            Link(destination: chatURL(s.id)) {
              HStack(spacing: 6) {
                Image(systemName: "message").font(.system(size: 12)).foregroundStyle(Color("$accent"))
                Text(s.title.isEmpty ? (zh ? "新对话" : "New conversation") : s.title)
                  .font(.system(size: 12, weight: .medium))
                  .foregroundStyle(Color("WidgetFg"))
                  .lineLimit(1)
                Spacer(minLength: 4)
                if let at = s.updatedAt {
                  Text(relativeText(at, zh: zh)).font(.system(size: 11)).foregroundStyle(Color("WidgetMuted"))
                }
              }
            }
          }
        }
      }

      Spacer(minLength: 0)
      LauncherPills(zh: zh)
    }
    .containerBackground(Color("$widgetBackground"), for: .widget)
  }

  private func sectionLabel(_ text: String) -> some View {
    Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(Color("WidgetMuted"))
  }
}

private func greetingName(_ snap: Snapshot?, zh: Bool) -> String {
  guard let name = snap?.nickname, !name.isEmpty else { return "" }
  return (zh ? "，" : ", ") + name
}

private struct RectangularLauncher: View {
  let entry: LauncherEntry

  var body: some View {
    let zh = isZh(entry.snapshot)
    let tasks = entry.snapshot?.tasks ?? []
    Group {
      if let t = tasks.first {
        let line = taskLine(t, zh: zh)
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 4) {
            Image(systemName: line.icon).font(.system(size: 12, weight: .semibold))
            Text(line.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
          }
          Text(line.detail).font(.system(size: 12)).lineLimit(1)
          if let next = t.nextRunAt {
            Text((zh ? "下次 " : "Next ") + nextRunText(next, zh: zh)).font(.system(size: 12)).opacity(0.8)
          }
        }
      } else {
        HStack(spacing: 6) {
          Image("sprouty").resizable().scaledToFit().frame(width: 22, height: 22)
          Text(zh ? "开始新对话" : "Start a new chat").font(.system(size: 13, weight: .semibold))
        }
      }
    }
    .containerBackground(Color.clear, for: .widget)
    .widgetURL(composeURL)
  }
}

private struct CircularLauncher: View {
  var body: some View {
    ZStack {
      AccessoryWidgetBackground()
      Image("sprouty")
        .resizable()
        .scaledToFit()
        .padding(5)
    }
    .containerBackground(Color.clear, for: .widget)
    .widgetURL(composeURL)
  }
}

struct LauncherWidgetView: View {
  @Environment(\.widgetFamily) private var family
  let entry: LauncherEntry

  var body: some View {
    switch family {
    case .systemMedium: MediumLauncher(entry: entry)
    case .systemLarge: LargeLauncher(entry: entry)
    case .accessoryRectangular: RectangularLauncher(entry: entry)
    case .accessoryCircular: CircularLauncher()
    default: SmallLauncher(entry: entry)
    }
  }
}

// MARK: - Widget

struct GreenhouseLauncher: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "GreenhouseLauncher", provider: LauncherProvider()) { entry in
      LauncherWidgetView(entry: entry)
    }
    .configurationDisplayName(systemZh ? "Greenhouse 快捷入口" : "Greenhouse Launcher")
    .description(systemZh ? "定时任务动态、最近会话，一键开始新对话。" : "Task updates, recent chats, and one-tap new conversations.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular])
  }
}

@main
struct GreenhouseWidgets: WidgetBundle {
  var body: some Widget {
    GreenhouseLauncher()
  }
}
