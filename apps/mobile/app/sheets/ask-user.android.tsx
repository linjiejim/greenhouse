// Android retains its inline form until its native sheet implementation is available.
import { Redirect } from 'expo-router';
export default function AskUserSheetAndroid() {
  return <Redirect href="/" />;
}
