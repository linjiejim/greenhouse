import ExpoModulesCore
import QuickLook

public class FilePreviewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FilePreview")
    View(FilePreviewView.self) {
      Events("onUnsupported")
      Prop("uri") { (view: FilePreviewView, uri: String) in view.load(uri) }
    }
  }
}

final class FilePreviewView: ExpoView, QLPreviewControllerDataSource {
  let onUnsupported = EventDispatcher()
  private let preview = QLPreviewController()
  private var file: URL?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    preview.dataSource = self
  }

  func load(_ uri: String) {
    // Only our downloaded cache files; never hand an authenticated remote URL to Quick Look.
    guard let url = URL(string: uri), url.isFileURL,
      let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
      url.resolvingSymlinksInPath().path.hasPrefix(cache.resolvingSymlinksInPath().path + "/"),
      QLPreviewController.canPreview(url as NSURL) else {
      file = nil
      preview.reloadData()
      onUnsupported([:])
      return
    }
    file = url
    preview.reloadData()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else {
      preview.willMove(toParent: nil)
      preview.view.removeFromSuperview()
      preview.removeFromParent()
      return
    }
    guard preview.parent == nil else { return }
    var responder: UIResponder? = self
    while let current = responder {
      if let parent = current as? UIViewController {
        parent.addChild(preview)
        addSubview(preview.view)
        preview.view.frame = bounds
        preview.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        preview.didMove(toParent: parent)
        return
      }
      responder = current.next
    }
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { file == nil ? 0 : 1 }
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    file! as NSURL
  }
}
