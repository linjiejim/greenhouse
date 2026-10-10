/**
 * Ends a Bot task's Live Activity from its "done" push while the app is in the background —
 * natively, with JS never started (spec docs/specs/20261010-mobile-live-activity.md §3.2, D6).
 *
 * Expo hands `didReceiveRemoteNotification` to every AppDelegate subscriber and merges their
 * results (expo-modules-core ExpoAppDelegateSubscriberManager), so this one runs beside
 * expo-notifications' own. Only pushes with `content-available` reach it in the background —
 * the server adds that for a device that shows tasks as Live Activities. With the app open
 * it stands aside: the app's own reconcile ends the activity (src/live-activity).
 */

import ExpoModulesCore
import UIKit

public class WidgetBridgeAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didReceiveRemoteNotification userInfo: [AnyHashable: Any],
    fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
  ) {
    guard #available(iOS 17.0, *), application.applicationState != .active, let push = TaskEndPush(userInfo) else {
      completionHandler(.noData)
      return
    }
    Task {
      let outcome = await TaskActivities.endFromPush(push)
      ActivityLog.append(run: push.run, outcome: outcome.rawValue, alerted: push.alerted)
      completionHandler(outcome == .ended ? .newData : .noData)
    }
  }
}
