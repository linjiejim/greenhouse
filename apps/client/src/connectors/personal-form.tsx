/**
 * Adding and editing my own connectors is a browser form (./personal-form.web.tsx); on the phone
 * 「我」 → 连接 lists, connects, refreshes and deletes them, and nothing renders here.
 */
import type { PersonalConnector } from '../api/connectors';

export function PersonalConnectorDialog(_props: {
  existing?: PersonalConnector;
  close: () => void;
  saved: () => void;
}): null {
  return null;
}
