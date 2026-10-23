import Foundation

/// Whether a failed upload may succeed if sent again. `status` is the HTTP status, or nil when no
/// answer came back (no network, a timeout). A 401 never reaches here: it means the sign-in
/// expired, which stops the whole share.
enum UploadFailure: Equatable {
  /// No answer, a timeout (408), too many requests (429) or a server error (5xx): try again.
  case retryable(String)
  /// The server said no for good (any other 4xx: a blocked file type, too large, no access).
  case refused(String)

  static func classify(status: Int?, words: String) -> UploadFailure {
    guard let status else { return .retryable(words) }
    if status == 408 || status == 429 || status >= 500 { return .retryable(words) }
    if (400..<500).contains(status) { return .refused(words) }
    return .retryable(words)
  }
}

/// Where each shared file stands, so a retry sends only the files that can still succeed and a
/// failure can say how far it got. Foundation-only; checked by src/share/ShareLogicCheck.swift
/// (run from src/share/share-logic.test.ts).
struct UploadProgress: Equatable {
  let total: Int
  private(set) var saved: Set<Int> = []
  /// Refused for good, with the server's reason; never retried to the same folder.
  private(set) var refused: [Int: String] = [:]
  /// Failed but worth retrying, with the reason.
  private(set) var failed: [Int: String] = [:]

  init(total: Int) {
    self.total = total
  }

  /// The files a (re)try sends, in the order they were shared: neither saved nor refused.
  var pending: [Int] { (0..<total).filter { !saved.contains($0) && refused[$0] == nil } }
  /// Failed files a retry may still save.
  var retryable: [Int] { pending.filter { failed[$0] != nil } }
  var savedCount: Int { saved.count }
  var isComplete: Bool { saved.count == total }
  /// The first retryable failure's reason, in shared order.
  var retryReason: String? { retryable.first.flatMap { failed[$0] } }

  mutating func markSaved(_ index: Int) {
    guard index >= 0, index < total else { return }
    saved.insert(index)
    failed[index] = nil
  }

  mutating func markFailed(_ index: Int, _ failure: UploadFailure) {
    guard index >= 0, index < total, !saved.contains(index) else { return }
    switch failure {
    case .retryable(let words): failed[index] = words
    case .refused(let words):
      refused[index] = words
      failed[index] = nil
    }
  }

  /// Another folder is another chance: refusals (no access to the folder, say) are forgotten.
  mutating func forgetRefusals() {
    refused = [:]
  }
}

/// Whether the extension speaks Chinese: the app's own language (the session carries it, see
/// src/share/payload.ts), else the phone's first preferred language.
func shareUsesChinese(appLanguage: String?, preferred: [String]) -> Bool {
  switch appLanguage {
  case "zh": return true
  case "en": return false
  default: return preferred.first?.hasPrefix("zh") ?? false
  }
}

/// The V1 brand green and the text on it, as 0xRRGGBB (src/theme/palette.ts `accent` /
/// `onAccent`; src/share/share-logic.test.ts keeps them equal).
enum Brand {
  static let accentLight = 0x2E8B3D
  static let accentDark = 0x76C97D
  static let onAccentLight = 0xFFFFFF
  static let onAccentDark = 0x0F1510
}
