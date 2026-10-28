import SwiftUI
import UIKit

/// The share sheet's "存到 Greenhouse": choose the shelf and folder, then upload.
final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
    let model = ShareViewModel(items: items) { [weak self] done in
      if done {
        self?.extensionContext?.completeRequest(returningItems: nil)
      } else {
        self?.extensionContext?.cancelRequest(withError: NSError(domain: "app.greenhouse.share", code: 0))
      }
    }
    let host = UIHostingController(rootView: ShareRootView(model: model))
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
  }
}

@MainActor
final class ShareViewModel: ObservableObject {
  enum Phase: Equatable {
    case choosing
    case uploading
    case finished(Int)
    /// Some files did not make it; `progress` says which are saved, refused or worth retrying.
    case failed
    case signedOut
  }

  let session = ShareSession.load()
  @Published var shelf: Shelf = .team
  @Published var phase: Phase = .choosing
  @Published var files: [SharedFile]? = nil {
    didSet { progress = UploadProgress(total: files?.count ?? 0) }
  }
  /// Survives a failure: a retry uploads only the files that can still succeed.
  @Published private(set) var progress = UploadProgress(total: 0)
  /// Where the last attempt went, for "retry the rest".
  private(set) var lastFolder: String?
  private let items: [NSExtensionItem]
  let finish: (Bool) -> Void

  init(items: [NSExtensionItem], finish: @escaping (Bool) -> Void) {
    self.items = items
    self.finish = finish
    Task { self.files = await collectSharedFiles(items) }
  }

  var api: ShareAPI? { session.map(ShareAPI.init) }

  func name(_ index: Int) -> String { files?[index].name ?? "" }

  func save(to folder: String?) {
    guard let api, let files, !files.isEmpty, !progress.pending.isEmpty else { return }
    lastFolder = folder
    phase = .uploading
    Task {
      // a refused or failed file does not stop the others; an expired sign-in stops them all
      let connection = L.t("Couldn’t upload. Check your connection and try again.", "上传失败，请检查网络后重试。")
      for index in progress.pending {
        do {
          try await api.upload(files[index], shelf: shelf, folder: folder)
          progress.markSaved(index)
        } catch ShareError.signedOut {
          phase = .signedOut
          return
        } catch ShareError.http(let status, let words) {
          progress.markFailed(index, .classify(status: status, words: words))
        } catch {
          progress.markFailed(index, .classify(status: nil, words: connection))
        }
      }
      if !progress.isComplete {
        phase = .failed
        return
      }
      phase = .finished(progress.savedCount)
      try? await Task.sleep(nanoseconds: 900_000_000)
      finish(true)
    }
  }

  /// Upload the files that failed for a passing reason, to the same place.
  func retry() {
    save(to: lastFolder)
  }

  /// Back to the folder list; refused files get another chance in another folder.
  func chooseAnotherFolder() {
    progress.forgetRefusals()
    phase = .choosing
  }
}

extension Color {
  /// The Haven accent, light and dark (ShareLogic.swift `Brand`).
  static let greenhouse = Color(dynamic: Brand.accentLight, Brand.accentDark)
  /// Text and glyphs on the green.
  static let onGreenhouse = Color(dynamic: Brand.onAccentLight, Brand.onAccentDark)

  init(dynamic light: Int, _ dark: Int) {
    func ui(_ rgb: Int) -> UIColor {
      UIColor(
        red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255,
        alpha: 1)
    }
    self.init(UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
  }
}

/// The filled green button the extension's main action uses.
struct PrimaryButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.semibold))
      .foregroundStyle(Color.onGreenhouse)
      .frame(maxWidth: .infinity, minHeight: 50)
      .background(Color.greenhouse.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.4), in: Capsule())
  }
}

struct ShareRootView: View {
  @ObservedObject var model: ShareViewModel

  var body: some View {
    NavigationStack {
      Group {
        if let session = model.session, !session.expired {
          switch model.phase {
          case .choosing:
            FolderList(model: model, parent: nil, title: nil)
          case .uploading:
            let total = model.progress.total
            let current = min(model.progress.savedCount + 1, total)
            VStack(spacing: 16) {
              ProgressView(value: Double(model.progress.savedCount), total: Double(max(total, 1)))
              Text(L.t("Uploading \(current) of \(total)…", "正在上传第 \(current) 个，共 \(total) 个…"))
                .foregroundStyle(.secondary)
            }
            .padding(32)
          case .finished(let count):
            VStack(spacing: 12) {
              Image(systemName: "checkmark.circle.fill").font(.system(size: 48)).foregroundStyle(Color.greenhouse)
              Text(L.t("Saved \(count) to Files", "已存入档案库 \(count) 个"))
            }
          case .failed:
            FailureView(model: model)
          case .signedOut:
            VStack(spacing: 12) {
              Image(systemName: "person.crop.circle.badge.exclamationmark").font(.system(size: 40)).foregroundStyle(.secondary)
              Text(L.t("Your sign-in expired. Open Greenhouse, then share again.", "登录已过期。请打开 Greenhouse 后再分享。"))
                .multilineTextAlignment(.center)
            }
            .padding(32)
          }
        } else {
          VStack(spacing: 12) {
            Image(systemName: "person.crop.circle.badge.exclamationmark").font(.system(size: 40)).foregroundStyle(.secondary)
            Text(L.t("Open Greenhouse and sign in, then share again.", "请先打开 Greenhouse 并登录，再来分享。"))
              .multilineTextAlignment(.center)
          }
          .padding(32)
        }
      }
      .navigationTitle(L.t("Save to Greenhouse", "存到 Greenhouse"))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button(L.t("Cancel", "取消")) { model.finish(false) }
        }
      }
    }
    .tint(Color.greenhouse)
  }
}

/// What did not make it: the files refused for good with their reasons (no retry), and a retry
/// for those that failed for a passing reason.
struct FailureView: View {
  @ObservedObject var model: ShareViewModel

  var body: some View {
    let progress = model.progress
    let retryable = progress.retryable.count
    let refused = progress.refused.keys.sorted()
    ScrollView {
      VStack(spacing: 12) {
        Image(systemName: "exclamationmark.triangle").font(.system(size: 40)).foregroundStyle(.orange)
        if progress.savedCount > 0 {
          Text(L.t("\(progress.savedCount) of \(progress.total) saved.", "已保存 \(progress.savedCount) 个（共 \(progress.total) 个）。"))
            .font(.headline)
        }
        if !refused.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Text(L.t("Couldn’t be saved:", "无法保存：")).font(.subheadline.weight(.semibold))
            ForEach(refused, id: \.self) { index in
              VStack(alignment: .leading, spacing: 2) {
                Text(model.name(index)).font(.subheadline)
                Text(progress.refused[index] ?? "").font(.footnote).foregroundStyle(.secondary)
              }
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        }
        if retryable > 0, let reason = progress.retryReason {
          Text(reason).multilineTextAlignment(.center).foregroundStyle(.secondary)
          Button(L.t("Retry the Remaining \(retryable)", "重试剩下的 \(retryable) 个")) { model.retry() }
            .buttonStyle(PrimaryButtonStyle())
        }
        Button(L.t("Choose Another Folder", "换个文件夹")) { model.chooseAnotherFolder() }
        if retryable == 0 || progress.savedCount > 0 {
          Button(L.t("Done", "完成")) { model.finish(progress.savedCount > 0) }
        }
      }
      .padding(32)
    }
  }
}

struct FolderList: View {
  @ObservedObject var model: ShareViewModel
  let parent: String?
  let title: String?
  @State private var folders: [Folder]? = nil
  @State private var failed = false

  var body: some View {
    List {
      if parent == nil {
        Section {
          Picker(L.t("Shelf", "书架"), selection: $model.shelf) {
            Text(L.t("Team", "团队")).tag(Shelf.team)
            Text(L.t("Mine", "我的")).tag(Shelf.personal)
          }
          .pickerStyle(.segmented)
        } footer: {
          if let session = model.session {
            Text("\(session.stationName) · \(session.memberName)")
          }
        }
      }
      Section(L.t("Folders", "文件夹")) {
        if let folders {
          if folders.isEmpty {
            Text(L.t("No folders here", "这里没有文件夹")).foregroundStyle(.secondary)
          }
          ForEach(folders) { folder in
            NavigationLink(value: folder) {
              Label(folder.name, systemImage: "folder")
            }
          }
        } else if failed {
          Text(L.t("Couldn’t load folders", "文件夹加载失败")).foregroundStyle(.secondary)
        } else {
          ProgressView()
        }
      }
    }
    .navigationTitle(title ?? L.t("Save to Greenhouse", "存到 Greenhouse"))
    .navigationDestination(for: Folder.self) { folder in
      FolderList(model: model, parent: folder.id, title: folder.name)
    }
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: 8) {
        if let countLabel {
          Text(countLabel).font(.footnote).foregroundStyle(.secondary)
        }
        Button(L.t("Save Here", "保存到这里")) {
          model.save(to: parent)
        }
        .buttonStyle(PrimaryButtonStyle())
        .disabled(model.progress.pending.isEmpty)
      }
      .padding()
      .background(.bar)
    }
    .task(id: "\(model.shelf.rawValue)-\(parent ?? "")") {
      folders = nil
      failed = false
      do {
        folders = try await model.api?.folders(shelf: model.shelf, parent: parent)
      } catch {
        failed = true
      }
    }
  }

  /// How many files the button saves, said beside it: all of them, or the ones left after a failure.
  private var countLabel: String? {
    let left = model.progress.pending.count
    guard left > 0 else { return nil }
    if model.progress.savedCount > 0 { return L.t("\(left) left to save", "还剩 \(left) 个") }
    return L.t(left == 1 ? "1 item" : "\(left) items", "\(left) 个文件")
  }
}
