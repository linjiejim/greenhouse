/**
 * Greenhouse home-screen widgets:
 *   · "我的任务" (systemSmall, systemMedium, accessoryRectangular) — the next three tasks due,
 *     overdue in red and due today in orange; a tap opens the task.
 *   · "最近文档" (systemSmall, systemMedium) — the three documents opened last; a tap opens it.
 *
 * Data is the App Group snapshot the app writes (modules/widget-bridge); `WidgetSnapshot` below
 * decodes the JSON whose shape lives in src/widget/model.ts — keep them in step. It holds titles,
 * dates and `greenhouse://` links (each naming its station) and nothing secret. No snapshot
 * (signed out, or never opened) shows a sign-in hint that opens the app. Words follow the app's
 * language from the snapshot, else the phone's.
 */

import SwiftUI
import WidgetKit

// MARK: - App Group snapshot (shape: src/widget/model.ts)

private let appGroup = "group.app.greenhouse.mobile"
private let snapshotKey = "widget_hub_snapshot_v1"

struct WidgetTask: Decodable, Hashable {
  let title: String
  let project: String
  let due: String?
  /// "overdue" | "today" | "soon" | "later" | "none" when the app wrote it; the widget works it
  /// out again from `due` and the entry's day (DueBuckets.swift).
  let bucket: String
  let url: String
}

struct WidgetDoc: Decodable, Hashable {
  let title: String
  let openedAt: Double
  let url: String
}

struct WidgetSnapshot: Decodable {
  let v: Int
  let stationName: String
  let lang: String
  let updatedAt: Double
  let tasks: [WidgetTask]
  let docs: [WidgetDoc]
}

private func loadSnapshot() -> WidgetSnapshot? {
  guard let json = UserDefaults(suiteName: appGroup)?.string(forKey: snapshotKey),
        let data = json.data(using: .utf8),
        let snap = try? JSONDecoder().decode(WidgetSnapshot.self, from: data),
        snap.v == 1
  else { return nil }
  return snap
}

// MARK: - Brand

/// The V1 green, light and dark (src/theme/palette.ts `accent`). Named colorsets do not reach
/// `Color.accentColor` in an extension, so it is spelled out here.
private let brand = Color(UIColor { traits in
  traits.userInterfaceStyle == .dark
    ? UIColor(red: 0x76 / 255, green: 0xC9 / 255, blue: 0x7D / 255, alpha: 1)
    : UIColor(red: 0x2E / 255, green: 0x8B / 255, blue: 0x3D / 255, alpha: 1)
})

// MARK: - Words

private struct Words {
  let zh: Bool

  init(_ snapshot: WidgetSnapshot?) {
    if let lang = snapshot?.lang { zh = lang == "zh" } else {
      zh = Locale.preferredLanguages.first?.hasPrefix("zh") ?? false
    }
  }

  func t(_ en: String, _ zhText: String) -> String { zh ? zhText : en }

  var myTasks: String { t("My Tasks", "我的任务") }
  var recentDocs: String { t("Recent Docs", "最近文档") }
  var signIn: String { t("Open Greenhouse to sign in", "打开 Greenhouse 登录") }
  var noTasks: String { t("Nothing due", "没有到期的任务") }
  var noDocs: String { t("Open a document in the app", "在 App 里打开一篇文档") }
  var overdue: String { t("Overdue", "已逾期") }
  var today: String { t("Today", "今天") }

  func opened(_ doc: WidgetDoc) -> String {
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = Locale(identifier: zh ? "zh_Hans_CN" : "en_US")
    formatter.unitsStyle = .short
    return formatter.localizedString(for: Date(timeIntervalSince1970: doc.openedAt), relativeTo: Date())
  }

  func dueLabel(_ task: WidgetTask, bucket: String) -> String? {
    switch bucket {
    case "overdue": return overdue
    case "today": return today
    default:
      guard let due = task.due else { return nil }
      let parse = DateFormatter()
      parse.dateFormat = "yyyy-MM-dd"
      parse.locale = Locale(identifier: "en_US_POSIX")
      // due dates are Gregorian whatever calendar the phone uses (DueBuckets.swift)
      parse.calendar = DueBuckets.calendar()
      parse.timeZone = parse.calendar.timeZone
      guard let date = parse.date(from: due) else { return nil }
      let out = DateFormatter()
      out.locale = Locale(identifier: zh ? "zh_Hans_CN" : "en_US")
      out.setLocalizedDateFormatFromTemplate("MMMd")
      return out.string(from: date)
    }
  }
}

// MARK: - Timeline

struct SnapshotEntry: TimelineEntry {
  let date: Date
  let snapshot: WidgetSnapshot?
}

struct SnapshotProvider: TimelineProvider {
  func placeholder(in context: Context) -> SnapshotEntry {
    SnapshotEntry(date: Date(), snapshot: nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
    completion(SnapshotEntry(date: Date(), snapshot: loadSnapshot()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
    // The app reloads the timelines whenever its copies change. Each entry works the due buckets
    // out for its own day, so a second entry at midnight moves "today" and "overdue" on time.
    let now = Date()
    let snapshot = loadSnapshot()
    var entries = [SnapshotEntry(date: now, snapshot: snapshot)]
    if let midnight = DueBuckets.nextDay(after: now) {
      entries.append(SnapshotEntry(date: midnight, snapshot: snapshot))
    }
    completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(3600))))
  }
}

// MARK: - Views

private let appURL = URL(string: "greenhouse://")!

private struct Header: View {
  let title: String
  let symbol: String

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: symbol).font(.caption.weight(.semibold)).foregroundStyle(brand)
      Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}

private struct Hint: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
  }
}

private struct TaskRow: View {
  let task: WidgetTask
  let words: Words
  let showProject: Bool
  /// The timeline entry's day: the due bucket is worked out for it, not taken from the app's copy.
  let today: Date

  var bucket: String { DueBuckets.bucket(due: task.due, today: today) }

  var tint: Color {
    switch bucket {
    case "overdue": return .red
    case "today": return .orange
    default: return .secondary
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(task.title).font(.subheadline.weight(.medium)).lineLimit(1)
      HStack(spacing: 4) {
        if let due = words.dueLabel(task, bucket: bucket) {
          Text(due).foregroundStyle(tint)
        }
        if showProject {
          Text(task.project).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      .font(.caption)
    }
    .accessibilityElement(children: .combine)
  }
}

private struct DocRow: View {
  let doc: WidgetDoc
  let words: Words
  let showOpened: Bool

  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "doc.text").font(.caption).foregroundStyle(brand)
      Text(doc.title).font(.subheadline.weight(.medium)).lineLimit(1)
      Spacer(minLength: 0)
      if showOpened {
        Text(words.opened(doc)).font(.caption).foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .combine)
  }
}

struct TasksView: View {
  let entry: SnapshotEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    let words = Words(entry.snapshot)
    let tasks = entry.snapshot?.tasks ?? []
    switch family {
    case .accessoryRectangular:
      VStack(alignment: .leading, spacing: 1) {
        Text(words.myTasks).font(.caption2.weight(.semibold))
        if let first = tasks.first {
          Text(first.title).font(.caption).lineLimit(1)
          if let due = words.dueLabel(first, bucket: DueBuckets.bucket(due: first.due, today: entry.date)) {
            Text(due).font(.caption2)
          }
        } else {
          Text(entry.snapshot == nil ? words.signIn : words.noTasks).font(.caption).lineLimit(2)
        }
      }
      .widgetURL(tasks.first.flatMap { URL(string: $0.url) } ?? appURL)
    default:
      VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 8) {
        Header(title: words.myTasks, symbol: "checkmark.circle")
        if entry.snapshot == nil {
          Hint(text: words.signIn)
        } else if tasks.isEmpty {
          Hint(text: words.noTasks)
        } else {
          ForEach(Array(tasks.prefix(3).enumerated()), id: \.offset) { _, task in
            if family == .systemSmall {
              TaskRow(task: task, words: words, showProject: false, today: entry.date)
            } else if let url = URL(string: task.url) {
              Link(destination: url) { TaskRow(task: task, words: words, showProject: true, today: entry.date) }
            }
          }
          Spacer(minLength: 0)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      // a small widget is one tap target: the first task
      .widgetURL(family == .systemSmall ? (tasks.first.flatMap { URL(string: $0.url) } ?? appURL) : appURL)
    }
  }
}

struct DocsView: View {
  let entry: SnapshotEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    let words = Words(entry.snapshot)
    let docs = entry.snapshot?.docs ?? []
    VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 8) {
      Header(title: words.recentDocs, symbol: "book")
      if entry.snapshot == nil {
        Hint(text: words.signIn)
      } else if docs.isEmpty {
        Hint(text: words.noDocs)
      } else {
        ForEach(Array(docs.prefix(3).enumerated()), id: \.offset) { _, doc in
          if family == .systemSmall {
            DocRow(doc: doc, words: words, showOpened: false)
          } else if let url = URL(string: doc.url) {
            Link(destination: url) { DocRow(doc: doc, words: words, showOpened: true) }
          }
        }
        Spacer(minLength: 0)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .widgetURL(family == .systemSmall ? (docs.first.flatMap { URL(string: $0.url) } ?? appURL) : appURL)
  }
}

// MARK: - Widgets

struct TasksWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "GreenhouseTasks", provider: SnapshotProvider()) { entry in
      TasksView(entry: entry).containerBackground(Color(.systemBackground), for: .widget)
    }
    .configurationDisplayName(Words(loadSnapshot()).myTasks)
    .description(Words(loadSnapshot()).t("The next tasks due, assigned to you.", "分配给你、最先到期的任务。"))
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
  }
}

struct DocsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "GreenhouseDocs", provider: SnapshotProvider()) { entry in
      DocsView(entry: entry).containerBackground(Color(.systemBackground), for: .widget)
    }
    .configurationDisplayName(Words(loadSnapshot()).recentDocs)
    .description(Words(loadSnapshot()).t("The documents you opened last.", "你最近打开的文档。"))
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

@main
struct GreenhouseWidgets: WidgetBundle {
  var body: some Widget {
    TasksWidget()
    DocsWidget()
  }
}
