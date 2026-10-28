/**
 * 发送反馈 (app/me/feedback.tsx, .android.tsx): the member's words plus what the app knows about
 * itself (./last-error.ts `feedbackContext`), sent to the active station. Success thanks the
 * member and goes back; failure keeps the words and says why.
 */

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { sendFeedback } from '../api/feedback';
import { captureIdentity } from '../data/identity';
import { useT } from '../lib/i18n';
import { useSettings } from '../settings/use-settings';
import { getApiBase } from '../store/stations';
import { alertError } from '../ui/dialogs';
import { notifySuccess } from '../ui/haptics';
import { toast } from '../ui/toast';
import { feedbackContext, lastErrorLine } from './last-error';

/** `read` gives the field's own text at send time (a native field's last edit can reach JS after the tap). */
export function useFeedback(read?: () => string | null | undefined) {
  const t = useT();
  const router = useRouter();
  const { version } = useSettings();
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [sent, setSent] = useState(false);
  const canSave = !!message.trim() && !saving && !sent;
  // close once the sent words cleared the discard guard (dirty turns off on the next render)
  useEffect(() => {
    if (sent) router.back();
  }, [sent, router]);
  const save = async () => {
    if (!canSave) return;
    const current = captureIdentity();
    setSaving(true);
    const context = feedbackContext({
      version,
      platform: `${Platform.OS} ${String(Platform.Version)}`,
      stationUrl: getApiBase(),
      lastError: lastErrorLine(),
    });
    const words = (read?.() ?? message).trim();
    if (!words) {
      setSaving(false);
      return;
    }
    const sent = await sendFeedback(words.slice(0, 4000), context);
    if (!current()) return;
    setSaving(false);
    if (!sent.ok) {
      alertError(t('feedback.failed'), sent.status === 404 ? t('feedback.unsupported') : sent.message || undefined);
      return;
    }
    notifySuccess();
    toast(t('feedback.thanks'), 'check');
    setSent(true);
  };
  return { message, setMessage, saving, canSave, dirty: !!message.trim() && !sent, save };
}
