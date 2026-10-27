/**
 * 发送反馈 (app/me/feedback.tsx, .android.tsx): the member's words plus what the app knows about
 * itself (./last-error.ts `feedbackContext`), sent to the active station. Success thanks the
 * member and goes back; failure keeps the words and says why.
 */

import { useState } from 'react';
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

export function useFeedback() {
  const t = useT();
  const router = useRouter();
  const { version } = useSettings();
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const canSave = !!message.trim() && !saving;
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
    const sent = await sendFeedback(message.trim().slice(0, 4000), context);
    if (!current()) return;
    setSaving(false);
    if (!sent.ok) {
      alertError(t('feedback.failed'), sent.status === 404 ? t('feedback.unsupported') : sent.message || undefined);
      return;
    }
    notifySuccess();
    toast(t('feedback.thanks'), 'check');
    router.back();
  };
  return { message, setMessage, saving, canSave, dirty: !!message.trim(), save };
}
