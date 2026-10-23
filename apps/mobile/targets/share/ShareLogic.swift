import Foundation

/// Which shared files are already saved, so a retry sends only the unfinished ones and a
/// failure can say how far it got. Foundation-only; checked by src/share/ShareLogicCheck.swift
/// (run from src/share/share-logic.test.ts).
struct UploadProgress: Equatable {
  let total: Int
  private(set) var saved: Set<Int> = []

  init(total: Int) {
    self.total = total
  }

  /// The files still to upload, in the order they were shared.
  var pending: [Int] { (0..<total).filter { !saved.contains($0) } }
  var savedCount: Int { saved.count }
  var isComplete: Bool { saved.count == total }

  mutating func markSaved(_ index: Int) {
    guard index >= 0, index < total else { return }
    saved.insert(index)
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
