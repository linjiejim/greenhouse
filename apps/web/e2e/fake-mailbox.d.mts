/** Types for fake-mailbox.mjs (the API's tests import it too). */

export interface FakeMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  date?: Date;
  messageId?: string;
  seen?: boolean;
}

export interface FakeMailboxState {
  user: string;
  password: string;
  logins: number;
  nextUid: number;
  messages: { uid: number; folder: string; flags: string[]; raw: string }[];
  sent: { from: string; to: string[]; raw: string }[];
}

export interface FakeMailbox {
  state: FakeMailboxState;
  imapPort: number;
  smtpPort: number;
  close(): Promise<void>;
}

export function rfc822(message: FakeMessage): string;
export function startFakeMailbox(options: {
  user: string;
  password: string;
  messages?: FakeMessage[];
}): Promise<FakeMailbox>;
