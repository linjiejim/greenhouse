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
    /// An upload stopped; `progress` says which files are already saved.
    case failed(String)
  }

  let session = ShareSession.load()
  @Published var shelf: Shelf = .team
  @Published var phase: Phase = .choosing
  @Published var files: [SharedFile]? = nil {
    didSet { progress = UploadProgress(total: files?.count ?? 0) }
  }
  /// Survives a failure: a retry uploads only the files not saved yet.
  @Published private(set) var progress = UploadProgress(total: 0)
  /// Where the last attempt went, for "retry the rest".
  private(set) var lastFolder: Int?
  private let items: [NSExtensionItem]
  let finish: (Bool) -> Void

  init(items: [NSExtensionItem], finish: @escaping (Bool) -> Void) {
    self.items = items
    self.finish = finish
    Task { self.files = await collectSharedFiles(items) }
  }

  var api: ShareAPI? { session.map(ShareAPI.init) }

  func save(to folder: Int?) {
    guard let api, let files, !files.isEmpty, !progress.pending.isEmpty else { return }
    lastFolder = folder
    phase = .uploading
    Task {
      for index in progress.pending {
        do {
          try await api.upload(files[index], shelf: shelf, folder: folder)
          progress.markSaved(index)
        } catch ShareError.signedOut {
          phase = .failed(L.t("Your sign-in expired. Open Greenhouse, then share again.", "登录已过期。请打开 Greenhouse 后再分享。"))
          return
        } catch ShareError.refused(let words) {
          phase = .failed(words)
          return
        } catch {
          phase = .failed(L.t("Couldn’t upload. Check your connection and try again.", "上传失败，请检查网络后重试。"))
          return
        }
      }
      phase = .finished(progress.savedCount)
      try? await Task.sleep(nanoseconds: 900_000_000)
      finish(true)
    }
  }

  /// Upload the files not saved yet to the same place.
  func retry() {
    save(to: lastFolder)
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
              Image(systemName: "checkmark.circle.fill").font(.system(size: 48)).foregroundStyle(Color.accentColor)
              Text(L.t("Saved \(count) to Files", "已存入档案库 \(count) 个"))
            }
          case .failed(let words):
            let saved = model.progress.savedCount
            let left = model.progress.pending.count
            VStack(spacing: 12) {
              Image(systemName: "exclamationmark.triangle").font(.system(size: 40)).foregroundStyle(.orange)
              Text(words).multilineTextAlignment(.center)
              if saved > 0 {
                Text(L.t("\(saved) of \(model.progress.total) already saved — they won’t be sent again.", "已保存 \(saved) 个（共 \(model.progress.total) 个），不会重复上传。"))
                  .font(.footnote)
                  .foregroundStyle(.secondary)
                  .multilineTextAlignment(.center)
              }
              Button(left == model.progress.total ? L.t("Try Again", "重试") : L.t("Retry the Remaining \(left)", "重试剩下的 \(left) 个")) {
                model.retry()
              }
              .buttonStyle(.borderedProminent)
              Button(L.t("Choose Another Folder", "换个文件夹")) { model.phase = .choosing }
              if saved > 0 {
                Button(L.t("Done", "完成")) { model.finish(true) }
              }
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
  }
}

struct FolderList: View {
  @ObservedObject var model: ShareViewModel
  let parent: Int?
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
      Button {
        model.save(to: parent)
      } label: {
        Text(saveLabel).frame(maxWidth: .infinity).padding(.vertical, 6)
      }
      .buttonStyle(.borderedProminent)
      .disabled(model.progress.pending.isEmpty)
      .padding()
      .background(.bar)
    }
    .task(id: "\(model.shelf.rawValue)-\(parent ?? 0)") {
      folders = nil
      failed = false
      do {
        folders = try await model.api?.folders(shelf: model.shelf, parent: parent)
      } catch {
        failed = true
      }
    }
  }

  private var saveLabel: String {
    let count = model.progress.pending.count
    return L.t("Save \(count) Here", "存 \(count) 个到这里")
  }
}
