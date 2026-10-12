/**
 * Greenhouse widget (v4) — the member's Bots on the home screen:
 *   · systemSmall          greeting + main face + compact other faces → new chat
 *   · systemMedium         main Agent row · [新会话] + 3 compact Bot faces
 *   · systemLarge          Greenhouse header · prominent main Agent + 3 rows · [新会话]
 *   · accessoryRectangular what is waiting on the member, or "start a new chat" (lock screen)
 *   · accessoryCircular    Sprouty silhouette → new chat (lock screen)
 * …and, in the same bundle, a Bot's background task as a Live Activity (lock screen +
 * Dynamic Island): BotTaskLiveActivity.swift.
 *
 * Data comes from the App Group snapshot written by modules/widget-bridge —
 * `Snapshot` below decodes the JSON whose SCHEMA TRUTH lives in
 * src/widget/model.ts (bump SNAPSHOT_VERSION together); avatars are PNGs the
 * app rendered into `widget-art/` (src/widget/art-host.tsx). No snapshot
 * (signed out / never opened) degrades every family to launcher-only mode;
 * `bots == nil` (Bots unavailable) shows recent conversations instead.
 *
 * Badges follow the app drawer's rule — one signal per Bot: "needs you"
 * (orange, pending cards) beats unread (accent, Bot replies; a dot when the
 * server didn't count them). "Replying…" is never shown: a snapshot would keep
 * saying it long after the reply ended.
 *
 * Deep links ride the `greenhouse://` scheme (expo-router): `bots?c=<dm>`
 * opens a Bot's thread (`&request=<id>` scrolls to the card waiting on the
 * member; no `c` bootstraps Sprouty's), `?compose=1` starts a new chat with
 * the default agent, `settings/bots`, `chat/<id>` resumes a
 * conversation. Strings mirror src/lib/i18n; language follows the snapshot's
 * app preference, falling back to the system locale.
 */

import WidgetKit
import SwiftUI

// MARK: - App Group snapshot (schema: src/widget/model.ts)

private let appGroup = "group.app.greenhouse.mobile"
private let snapshotKey = "widget_snapshot_v1"
private let supportedSnapshotVersion = 2
private let artFolder = "widget-art"

struct SnapshotArt: Decodable {
  let light: String
  let dark: String
}
struct SnapshotBot: Decodable {
  let id: String
  let sessionId: String?
  let name: String
  let art: SnapshotArt
  let sprouty: Bool
  /// "needs_you" | "unread" | nil
  let badge: String?
  /// needs_you → pending cards; unread → Bot replies; nil → a dot
  let count: Int?
  let requestId: String?
  let preview: String
  let lastAt: Double?
}
struct SnapshotAgent: Decodable {
  let name: String
  let art: SnapshotArt
  let sleep: SnapshotArt
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
  // Optional so a v1 snapshot (left by the previous build until the app next runs) still decodes.
  let defaultAgent: SnapshotAgent?
  let bots: [SnapshotBot]?
  let sessions: [SnapshotSession]?
}

private func loadSnapshot() -> Snapshot? {
  guard let json = UserDefaults(suiteName: appGroup)?.string(forKey: snapshotKey),
        let data = json.data(using: .utf8),
        let snap = try? JSONDecoder().decode(Snapshot.self, from: data),
        snap.v <= supportedSnapshotVersion
  else { return nil }
  return snap
}

/** The App Group folder of rendered faces — the Live Activity (BotTaskLiveActivity.swift) reads it too. */
let artDirectory: URL? = FileManager.default
  .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
  .appendingPathComponent(artFolder, isDirectory: true)

/** A face the app rendered for this colour scheme, or nil (not rendered / gone). */
private func artImage(_ art: SnapshotArt?, scheme: ColorScheme) -> UIImage? {
  guard let art, let dir = artDirectory else { return nil }
  let key = scheme == .dark ? art.dark : art.light
  guard !key.isEmpty else { return nil }
  return UIImage(contentsOfFile: dir.appendingPathComponent("\(key).png").path)
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

private func greetingName(_ snap: Snapshot?, zh: Bool) -> String {
  guard let name = snap?.nickname, !name.isEmpty else { return "" }
  return (zh ? "，" : ", ") + name
}

private func countText(_ n: Int) -> String { n > 99 ? "99+" : "\(n)" }

/** What a Bot's badge says, for VoiceOver and the lock screen. */
private func signalText(_ bot: SnapshotBot, zh: Bool) -> String? {
  switch bot.badge {
  case "needs_you":
    let n = countText(bot.count ?? 1)
    return zh ? "需要你 · \(n)" : "Needs You · \(n)"
  case "unread":
    guard let n = bot.count else { return zh ? "未读" : "Unread" }
    return zh ? "\(countText(n)) 条未读" : "\(countText(n)) unread"
  default:
    return nil
  }
}

// MARK: - Time formatting

private func hm(_ ms: Double, zh: Bool) -> String {
  let f = DateFormatter()
  f.locale = Locale(identifier: zh ? "zh_CN" : "en_US")
  f.dateFormat = "HH:mm"
  return f.string(from: Date(timeIntervalSince1970: ms / 1000))
}

private func relativeText(_ ms: Double, zh: Bool) -> String {
  let f = RelativeDateTimeFormatter()
  f.locale = Locale(identifier: zh ? "zh_CN" : "en_US")
  f.unitsStyle = .short
  return f.localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date())
}

/** A row's time, Messages-style (src/bots/drawer/row-text.ts `rowTime`): today's clock, Yesterday, the weekday, the date. */
private func rowTime(_ ms: Double, now: Date, zh: Bool) -> String {
  let date = Date(timeIntervalSince1970: ms / 1000)
  let cal = Calendar.current
  let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: cal.startOfDay(for: now)).day ?? 0
  let f = DateFormatter()
  f.locale = Locale(identifier: zh ? "zh_CN" : "en_US")
  if days <= 0 {
    f.dateFormat = "HH:mm"
  } else if days == 1 {
    return zh ? "昨天" : "Yesterday"
  } else if days < 7 {
    f.dateFormat = "EEE"
  } else {
    f.dateFormat = cal.isDate(date, equalTo: now, toGranularity: .year) ? "M/d" : "yyyy/M/d"
  }
  return f.string(from: date)
}

private func isNight(_ date: Date) -> Bool {
  let h = Calendar.current.component(.hour, from: date)
  return h < 6 || h >= 22
}

// MARK: - Deep links (routes in apps/mobile/app/)

private let composeURL = URL(string: "greenhouse://?compose=1")!
private let botsURL = URL(string: "greenhouse://bots")!
private let newBotURL = URL(string: "greenhouse://settings/bots")!

func query(_ value: String) -> String {
  value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value
}

private func chatURL(_ id: String) -> URL {
  URL(string: "greenhouse://chat/\(query(id))") ?? composeURL
}

/** The Bot's thread — at the card waiting on the member when there is one. No DM yet → Sprouty's bootstrap. */
private func botURL(_ bot: SnapshotBot) -> URL {
  guard let sid = bot.sessionId else { return botsURL }
  var link = "greenhouse://bots?c=\(query(sid))"
  if bot.badge == "needs_you", let request = bot.requestId { link += "&request=\(query(request))" }
  return URL(string: link) ?? botsURL
}

// MARK: - Timeline (hourly keeps greeting / night face / times current)

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

// MARK: - Faces

/**
 * Sprouty's bundled plant avatar (the sprout) — the face when nothing better is
 * known; late at night it folds into a sleeping bud.
 * Art: apps/mobile/scripts/render-widget-art.mjs (re-run it, don't hand-edit the PNGs).
 */
private func sproutyImage(night: Bool, scheme: ColorScheme) -> Image {
  let pose = night ? "sproutySleep" : "sprouty"
  return Image(scheme == .dark ? pose + "Dark" : pose)
}

/**
 * Lock-screen accessory families are system-tinted: only alpha survives, so they get the
 * single-colour silhouette with the eyes knocked out as holes, drawn as a template.
 */
private func sproutyMono() -> Image {
  Image("sproutyMono").renderingMode(.template)
}

/**
 * A plant face, scaled to its frame. No `.widgetAccentedRenderingMode(...)`: on an image
 * inside a Link it takes the image out of the Link's tap area (the tap then just opens the
 * app) — tinted home screens get the system's default treatment instead.
 */
private struct FaceImage: View {
  let image: Image

  var body: some View {
    image.resizable().scaledToFit()
  }
}

/** The default agent's face (new chat): its rendered art, else Sprouty's bundled one. */
private struct AgentFace: View {
  @Environment(\.colorScheme) private var scheme
  let agent: SnapshotAgent?
  let date: Date
  let size: CGFloat

  var body: some View {
    let night = isNight(date)
    Group {
      if let image = artImage(night ? agent?.sleep : agent?.art, scheme: scheme) {
        FaceImage(image: Image(uiImage: image))
      } else {
        FaceImage(image: sproutyImage(night: night, scheme: scheme))
      }
    }
    .frame(width: size, height: size)
  }
}

/** A Bot's face with its badge at the top right. Missing art: Sprouty's bundled face, or the name's initial. */
private struct BotFace: View {
  @Environment(\.colorScheme) private var scheme
  let bot: SnapshotBot
  let size: CGFloat
  var showsBadge: Bool = true

  var body: some View {
    Group {
      if let image = artImage(bot.art, scheme: scheme) {
        FaceImage(image: Image(uiImage: image))
      } else if bot.sprouty {
        FaceImage(image: sproutyImage(night: false, scheme: scheme))
      } else {
        Circle()
          .fill(Color("AccentTint"))
          .overlay(
            Text(String(bot.name.prefix(1)))
              .font(.system(size: size * 0.42, weight: .semibold))
              .foregroundStyle(Color("$accent"))
          )
      }
    }
    .frame(width: size, height: size)
    .overlay(alignment: .topTrailing) {
      if showsBadge { BadgeView(bot: bot, compact: size < 36).offset(x: 5, y: -3) }
    }
  }
}

/** One signal: orange = needs you (card count), accent = unread (reply count, or a dot). */
private struct BadgeView: View {
  let bot: SnapshotBot
  var compact: Bool = false

  var body: some View {
    if bot.badge == "needs_you" || bot.badge == "unread" {
      let needsYou = bot.badge == "needs_you"
      let fill = needsYou ? Color.orange : Color("$accent")
      let ink = needsYou ? Color.white : Color("OnAccent")
      Group {
        if let n = bot.count, n > 0 {
          Text(countText(n))
            .font(.system(size: compact ? 9 : 11.5, weight: .semibold))
            .monospacedDigit()
            .foregroundStyle(ink)
            .padding(.horizontal, compact ? 3 : 5)
            .frame(minWidth: compact ? 14 : 19, minHeight: compact ? 14 : 19)
            .background(Capsule().fill(fill))
        } else {
          Circle().fill(fill).frame(width: 11, height: 11)
        }
      }
      .padding(2)
      .background(Capsule().fill(Color("$widgetBackground")))
      .widgetAccentable()
    }
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

private struct NewChatLink: View {
  let entry: LauncherEntry
  let zh: Bool

  var body: some View {
    Link(destination: composeURL) {
      AccentPill(icon: "square.and.pencil", label: zh ? "新会话" : "New chat")
    }
    .accessibilityLabel(newChatA11y(entry.snapshot, zh: zh))
  }
}

private func newChatA11y(_ snap: Snapshot?, zh: Bool) -> String {
  guard let name = snap?.defaultAgent?.name, !name.isEmpty else { return zh ? "新会话" : "New chat" }
  return zh ? "新会话，\(name)" : "New chat, \(name)"
}

private struct UpdatedLabel: View {
  let snapshot: Snapshot?
  let zh: Bool

  var body: some View {
    if let snap = snapshot {
      Text(zh ? hm(snap.updatedAt, zh: zh) + " 更新" : "Updated " + hm(snap.updatedAt, zh: zh))
        .font(.system(size: 10))
        .foregroundStyle(Color.secondary)
    }
  }
}

private func botA11y(_ bot: SnapshotBot, zh: Bool) -> String {
  guard let signal = signalText(bot, zh: zh) else { return bot.name }
  return (zh ? "\(bot.name)，" : "\(bot.name), ") + signal
}

/** Only Sprouty so far: one dashed "New Agent" slot (Settings → My Bots), never a row of empties. */
private struct NewBotCell: View {
  let zh: Bool
  let size: CGFloat

  var body: some View {
    Circle()
      .strokeBorder(Color.secondary.opacity(0.45), style: StrokeStyle(lineWidth: 1.5, dash: [4, 3]))
      .overlay(Image(systemName: "plus").font(.system(size: size * 0.36, weight: .light)).foregroundStyle(Color.secondary))
      .frame(width: size, height: size)
  }
}

/** Reused by the main row and the compact large-widget rows. */
private struct BotRow: View {
  let bot: SnapshotBot
  let now: Date
  let zh: Bool
  var prominent: Bool = false

  var body: some View {
    Link(destination: botURL(bot)) {
      HStack(spacing: 11) {
        BotFace(bot: bot, size: prominent ? 62 : 34)
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 5) {
            Text(bot.name).font(.system(size: prominent ? 18 : 14, weight: .semibold)).foregroundStyle(Color.primary).lineLimit(1)
            Spacer(minLength: 4)
            if let at = bot.lastAt {
              Text(rowTime(at, now: now, zh: zh)).font(.system(size: 11.5)).foregroundStyle(Color.secondary)
            }
          }
          previewLine
        }
      }
      .contentShape(Rectangle())
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(botA11y(bot, zh: zh))
    }
  }

  @ViewBuilder private var previewLine: some View {
    if bot.badge == "needs_you" {
      (Text(zh ? "需要你 · " : "Needs You · ") + Text(bot.preview).foregroundStyle(Color.secondary))
        .font(.system(size: 12.5))
        .foregroundStyle(Color.orange)
        .lineLimit(prominent ? 2 : 1)
        .privacySensitive()
    } else if !bot.preview.isEmpty {
      Text(bot.preview).font(.system(size: 12.5)).foregroundStyle(Color.secondary).lineLimit(prominent ? 2 : 1).privacySensitive()
    }
  }
}

private struct SessionRow: View {
  let session: SnapshotSession
  let zh: Bool

  var body: some View {
    Link(destination: chatURL(session.id)) {
      HStack(spacing: 6) {
        Image(systemName: "message").font(.system(size: 12)).foregroundStyle(Color("$accent"))
        Text(session.title.isEmpty ? (zh ? "新会话" : "New chat") : session.title)
          .font(.system(size: 12.5, weight: .medium))
          .foregroundStyle(Color.primary)
          .lineLimit(1)
          .privacySensitive()
        Spacer(minLength: 4)
        if let at = session.updatedAt {
          Text(relativeText(at, zh: zh)).font(.system(size: 11)).foregroundStyle(Color.secondary)
        }
      }
    }
  }
}

private func sectionLabel(_ text: String) -> some View {
  Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.secondary)
}

private func emptyPrompt(_ zh: Bool, size: CGFloat) -> some View {
  Text(zh ? "今天想做点什么？" : "What shall we do today?")
    .font(.system(size: size, weight: .bold))
    .foregroundStyle(Color.primary)
}

// MARK: - Families

private struct SmallLauncher: View {
  let entry: LauncherEntry

  var body: some View {
    let zh = isZh(entry.snapshot)
    let others = Array((entry.snapshot?.bots ?? []).filter { !$0.sprouty }.prefix(3))
    VStack(spacing: 6) {
      Text(greetingText(for: entry.date, zh: zh))
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Color.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
      AgentFace(agent: entry.snapshot?.defaultAgent, date: entry.date, size: 76)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      HStack(spacing: 6) {
        HStack(spacing: 5) {
          Image(systemName: "square.and.pencil").font(.system(size: 14, weight: .semibold))
          if others.isEmpty { Text(zh ? "新会话" : "New chat").font(.system(size: 12, weight: .semibold)) }
        }
        .foregroundStyle(Color("OnAccent"))
        .frame(maxWidth: others.isEmpty ? .infinity : nil)
        .frame(minWidth: 32, minHeight: 32)
        .background(Capsule().fill(Color("$accent")))
        if !others.isEmpty {
          Spacer(minLength: 0)
          // Small WidgetKit families have one whole-card URL: these faces are summaries.
          ForEach(others, id: \.id) { bot in BotFace(bot: bot, size: 24, showsBadge: false) }
        }
      }
    }
    .containerBackground(Color("$widgetBackground"), for: .widget)
    .widgetURL(composeURL)
    .accessibilityLabel(newChatA11y(entry.snapshot, zh: zh))
  }
}

private struct MediumLauncher: View {
  let entry: LauncherEntry

  var body: some View {
    let zh = isZh(entry.snapshot)
    let bots = Array((entry.snapshot?.bots ?? []).prefix(4))
    VStack(alignment: .leading, spacing: 4) {
      if let main = bots.first {
        BotRow(bot: main, now: entry.date, zh: zh, prominent: true)
        Spacer(minLength: 0)
        HStack(spacing: 12) {
          NewChatLink(entry: entry, zh: zh)
          Spacer(minLength: 0)
          ForEach(bots.dropFirst(), id: \.id) { bot in
            Link(destination: botURL(bot)) {
              BotFace(bot: bot, size: 28)
                .frame(width: 36, height: 36)
                .contentShape(Rectangle())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(botA11y(bot, zh: zh))
            }
          }
        }
      } else if let sessions = entry.snapshot?.sessions, entry.snapshot?.bots == nil, !sessions.isEmpty {
        sectionLabel(zh ? "继续对话" : "Continue chatting")
        VStack(alignment: .leading, spacing: 6) {
          ForEach(sessions.prefix(2), id: \.id) { s in SessionRow(session: s, zh: zh) }
        }
        Spacer(minLength: 0)
        NewChatLink(entry: entry, zh: zh)
      } else {
        HStack(spacing: 12) {
          AgentFace(agent: entry.snapshot?.defaultAgent, date: entry.date, size: 62)
          VStack(alignment: .leading, spacing: 2) {
            Text(greetingText(for: entry.date, zh: zh) + greetingName(entry.snapshot, zh: zh))
              .font(.system(size: 12, weight: .medium)).foregroundStyle(Color.secondary).lineLimit(1)
            emptyPrompt(zh, size: 15)
          }
        }
        .frame(maxHeight: .infinity)
        NewChatLink(entry: entry, zh: zh)
      }
      UpdatedLabel(snapshot: entry.snapshot, zh: zh).frame(maxWidth: .infinity, alignment: .trailing)
    }
    .containerBackground(Color("$widgetBackground"), for: .widget)
  }
}

private struct LargeLauncher: View {
  let entry: LauncherEntry

  var body: some View {
    let zh = isZh(entry.snapshot)
    let bots = Array((entry.snapshot?.bots ?? []).prefix(4))
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 6) {
        Image("greenhouseMark").renderingMode(.template).resizable().scaledToFit()
          .foregroundStyle(Color("$accent")).frame(width: 28, height: 28)
        Text("Greenhouse").font(.system(size: 15, weight: .semibold)).foregroundStyle(Color.primary)
      }
      if let main = bots.first {
        BotRow(bot: main, now: entry.date, zh: zh, prominent: true)
          .padding(10)
          .background(RoundedRectangle(cornerRadius: 18).fill(Color("AccentTint")))
        VStack(alignment: .leading, spacing: 12) {
          ForEach(bots.dropFirst(), id: \.id) { bot in BotRow(bot: bot, now: entry.date, zh: zh) }
          if bots.count == 1 {
            Link(destination: newBotURL) {
              HStack(spacing: 11) {
                NewBotCell(zh: zh, size: 34)
                Text(zh ? "新建 Agent" : "New Agent").font(.system(size: 14)).foregroundStyle(Color.secondary)
              }
            }
          }
        }
      } else if let sessions = entry.snapshot?.sessions, entry.snapshot?.bots == nil {
        sectionLabel(zh ? "继续对话" : "Continue chatting")
        if sessions.isEmpty {
          Text(zh ? "暂无最近会话" : "No recent conversations").font(.system(size: 12)).foregroundStyle(Color.secondary)
        } else {
          VStack(alignment: .leading, spacing: 10) {
            ForEach(sessions.prefix(4), id: \.id) { s in SessionRow(session: s, zh: zh) }
          }
        }
      } else {
        emptyPrompt(zh, size: 17).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      Spacer(minLength: 0)
      HStack(alignment: .bottom, spacing: 8) {
        NewChatLink(entry: entry, zh: zh)
        Spacer(minLength: 4)
        UpdatedLabel(snapshot: entry.snapshot, zh: zh)
      }
    }
    .containerBackground(Color("$widgetBackground"), for: .widget)
  }
}

/** Lock screen: what is waiting on the member (needs you first, then unread) — one tap → the first of them. */
private struct RectangularLauncher: View {
  let entry: LauncherEntry

  var body: some View {
    let zh = isZh(entry.snapshot)
    let bots = entry.snapshot?.bots ?? []
    let waiting = bots.filter { $0.badge == "needs_you" } + bots.filter { $0.badge == "unread" }
    Group {
      if let first = waiting.first {
        VStack(alignment: .leading, spacing: 1) {
          Text(first.badge == "needs_you" ? (zh ? "需要你" : "Needs You") : (zh ? "未读" : "Unread"))
            .font(.system(size: 11, weight: .semibold))
            .opacity(0.7)
          ForEach(waiting.prefix(2), id: \.id) { bot in
            HStack(spacing: 4) {
              Image(systemName: bot.badge == "needs_you" ? "bell.fill" : "bubble.left.fill")
                .font(.system(size: 10, weight: .semibold))
              Text(bot.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
              Spacer(minLength: 2)
              if let n = bot.count {
                Text(countText(n)).font(.system(size: 13, weight: .semibold)).monospacedDigit()
              }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(botA11y(bot, zh: zh))
          }
        }
        .widgetURL(botURL(first))
      } else {
        HStack(spacing: 6) {
          sproutyMono().resizable().scaledToFit().frame(width: 22, height: 22)
          Text(zh ? "开始新会话" : "Start a new chat").font(.system(size: 13, weight: .semibold))
        }
        .widgetURL(composeURL)
      }
    }
    .containerBackground(Color.clear, for: .widget)
  }
}

private struct CircularLauncher: View {
  var body: some View {
    ZStack {
      AccessoryWidgetBackground()
      sproutyMono()
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
    // `kind` stays the same: widgets already on home screens upgrade in place.
    StaticConfiguration(kind: "GreenhouseLauncher", provider: LauncherProvider()) { entry in
      LauncherWidgetView(entry: entry)
    }
    .configurationDisplayName(systemZh ? "Greenhouse 快捷入口" : "Greenhouse Launcher")
    .description(
      systemZh
        ? "你的 Agent 和它们的新消息，一键进入对话或开始新会话。"
        : "Your Agents and what's new with them — one tap into a chat, or start a new one."
    )
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular])
  }
}

@main
struct GreenhouseWidgets: WidgetBundle {
  var body: some Widget {
    GreenhouseLauncher()
    BotTaskLiveActivity()
  }
}
