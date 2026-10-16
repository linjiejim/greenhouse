/** One toast at a time: what just happened, with at most one action (Undo, Retry). */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Toast } from '@greenhouse/ui/kit';

interface Notice {
  id: number;
  text: string;
  action?: { label: string; onClick: () => void };
}

type Notify = (text: string, action?: Notice['action']) => void;

const NotifyContext = createContext<Notify>(() => undefined);

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const notify = useCallback<Notify>((text, action) => setNotice({ id: Date.now(), text, action }), []);
  const value = useMemo(() => notify, [notify]);
  return (
    <NotifyContext.Provider value={value}>
      {children}
      {notice && (
        <Toast
          key={notice.id}
          text={notice.text}
          action={
            notice.action && {
              label: notice.action.label,
              onClick: () => {
                notice.action!.onClick();
                setNotice(null);
              },
            }
          }
          onClose={() => setNotice(null)}
        />
      )}
    </NotifyContext.Provider>
  );
}

export const useNotify = () => useContext(NotifyContext);
