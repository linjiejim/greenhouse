/**
 * Opening links the iOS way: web pages open in an in-app Safari view
 * (SFSafariViewController — Reader, sharing, AutoFill, back to the app with
 * one tap), tinted with the accent; mailto: / tel: go to the system handler.
 * Never send a web link straight to Safari with Linking — it throws the user
 * out of the app.
 */

import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

export async function openLink(url: string, accentHex?: string): Promise<void> {
  if (/^https?:\/\//i.test(url)) {
    await WebBrowser.openBrowserAsync(url, {
      controlsColor: accentHex,
      dismissButtonStyle: 'close',
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      readerMode: false,
    });
    return;
  }
  if (/^(mailto|tel):/i.test(url)) await Linking.openURL(url);
}
