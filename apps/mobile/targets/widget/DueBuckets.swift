/**
 * When a task is due, seen from a given day: the same rule as src/data/tasks.ts `dueBucket`
 * (src/widget/model.test.ts compiles this file with swiftc and compares the two). The widget
 * works it out from each task's due date and the timeline entry's day, so "overdue" and "today"
 * stay right after midnight without the app running.
 */

import Foundation

enum DueBuckets {
  /// Due within this many days counts as "soon" (src/data/tasks.ts `soonDays`).
  static let soonDays = 7

  /// "overdue" | "today" | "soon" | "later" | "none" for `due` (`yyyy-MM-dd`, optionally with a
  /// time after it) seen on `today`'s calendar day.
  static func bucket(due: String?, today: Date, calendar: Calendar = .current) -> String {
    guard let due else { return "none" }
    let day = String(due.prefix(10))
    guard day.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else { return "none" }
    let todayKey = dayKey(today, calendar)
    if day < todayKey { return "overdue" }
    if day == todayKey { return "today" }
    guard let soon = calendar.date(byAdding: .day, value: soonDays, to: today) else { return "later" }
    return day <= dayKey(soon, calendar) ? "soon" : "later"
  }

  /// The start of the calendar day after `date`, when the buckets next change.
  static func nextDay(after date: Date, calendar: Calendar = .current) -> Date? {
    calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: date))
  }

  static func dayKey(_ date: Date, _ calendar: Calendar) -> String {
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
  }
}
