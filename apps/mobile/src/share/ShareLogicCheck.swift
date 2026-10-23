// Checks for targets/share/ShareLogic.swift, compiled together with it by
// ./share-logic.test.ts (`swiftc ShareLogic.swift ShareLogicCheck.swift`), outside the extension.

import Foundation

@main
struct ShareLogicCheck {
  static var failures = 0

  static func expect(_ condition: Bool, _ what: String, line: Int = #line) {
    if !condition {
      failures += 1
      print("FAIL line \(line): \(what)")
    }
  }

  static func main() {
    // A retry sends only the files that were not saved.
    var progress = UploadProgress(total: 3)
    expect(progress.pending == [0, 1, 2], "everything is pending at first")
    progress.markSaved(0)
    expect(progress.pending == [1, 2], "the first saved file is not sent again")
    expect(progress.savedCount == 1 && !progress.isComplete, "one of three saved")
    progress.markSaved(2)
    expect(progress.pending == [1], "only the unfinished file is retried")
    progress.markSaved(1)
    expect(progress.isComplete && progress.pending.isEmpty, "all saved, nothing left")

    // Saving twice, or an index that is not there, changes nothing.
    var bounded = UploadProgress(total: 2)
    bounded.markSaved(1)
    bounded.markSaved(1)
    bounded.markSaved(5)
    bounded.markSaved(-1)
    expect(bounded.savedCount == 1 && bounded.pending == [0], "repeats and strays are ignored")

    // Nothing shared, nothing to do.
    expect(UploadProgress(total: 0).pending.isEmpty, "no files, no work")

    if failures > 0 {
      print("\(failures) check(s) failed")
      exit(1)
    }
    print("ok")
  }
}
