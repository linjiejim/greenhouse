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

    // Which failures a retry can fix.
    expect(UploadFailure.classify(status: nil, words: "offline") == .retryable("offline"), "no answer is worth retrying")
    for status in [408, 429, 500, 502, 503, 504] {
      expect(UploadFailure.classify(status: status, words: "x") == .retryable("x"), "\(status) is worth retrying")
    }
    for status in [400, 403, 404, 409, 413, 415, 422] {
      expect(UploadFailure.classify(status: status, words: "x") == .refused("x"), "\(status) is refused for good")
    }

    // A refused file is listed with its reason and never retried; a passing failure is.
    var mixed = UploadProgress(total: 3)
    mixed.markSaved(0)
    mixed.markFailed(1, .refused("blocked script"))
    mixed.markFailed(2, .retryable("offline"))
    expect(mixed.refused == [1: "blocked script"], "the refusal keeps its reason")
    expect(mixed.pending == [2] && mixed.retryable == [2], "only the passing failure is retried")
    expect(mixed.retryReason == "offline", "the retry says why")
    mixed.markSaved(2)
    expect(mixed.retryable.isEmpty && mixed.pending.isEmpty && !mixed.isComplete, "nothing left to retry, one refused")

    // Nothing retryable: no retry is offered.
    var refusedOnly = UploadProgress(total: 2)
    refusedOnly.markFailed(0, .refused("too large"))
    refusedOnly.markFailed(1, .refused("blocked"))
    expect(refusedOnly.retryable.isEmpty && refusedOnly.pending.isEmpty, "all refused, nothing to retry")

    // Another folder gives refused files another chance; a saved file is never re-sent.
    refusedOnly.forgetRefusals()
    expect(refusedOnly.pending == [0, 1], "a new folder tries the refused files again")
    mixed.forgetRefusals()
    expect(mixed.pending == [1], "but never the saved ones")

    // A failure after a save does not unsave it.
    var settled = UploadProgress(total: 1)
    settled.markSaved(0)
    settled.markFailed(0, .refused("late"))
    expect(settled.isComplete && settled.refused.isEmpty, "a saved file stays saved")

    // The extension speaks the app's language, else the phone's.
    expect(shareUsesChinese(appLanguage: "zh", preferred: ["en-US"]), "the app's Chinese wins over an English phone")
    expect(!shareUsesChinese(appLanguage: "en", preferred: ["zh-Hans-CN"]), "the app's English wins over a Chinese phone")
    expect(shareUsesChinese(appLanguage: nil, preferred: ["zh-Hans-CN", "en"]), "an older session follows a Chinese phone")
    expect(!shareUsesChinese(appLanguage: nil, preferred: []), "no preference reads English")

    // The brand colours, printed for the vitest side to compare with src/theme/palette.ts.
    print(String(format: "brand %06X %06X %06X %06X", Brand.accentLight, Brand.accentDark, Brand.onAccentLight, Brand.onAccentDark))

    if failures > 0 {
      print("\(failures) check(s) failed")
      exit(1)
    }
    print("ok")
  }
}
