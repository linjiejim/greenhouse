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
