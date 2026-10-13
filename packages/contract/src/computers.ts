import { z } from 'zod';
import { isoTime } from './common.js';

export const COMPUTER_STATES = ['stopped', 'starting', 'running', 'failed'] as const;

/** An Agent's computer: a sandbox whose home outlives restarts. */
export const computerSchema = z.object({
  agent_id: z.string(),
  state: z.enum(COMPUTER_STATES),
  state_reason: z.string().nullable(),
  last_active_at: isoTime.nullable(),
  last_started_at: isoTime.nullable(),
});
export type ComputerView = z.infer<typeof computerSchema>;

/** A background process on the computer; `lost` means the computer restarted under it. */
export const computerJobSchema = z.object({
  id: z.string(),
  name: z.string(),
  command: z.string(),
  status: z.enum(['running', 'exited', 'lost']),
  exit_code: z.number().int().nullable(),
  started_at: isoTime.nullable(),
  ended_at: isoTime.nullable(),
});
export type ComputerJob = z.infer<typeof computerJobSchema>;

/**
 * What a ticket opens. `view` and `control` open the screen (`/api/ws/computer`); only `control`
 * sends keys and clicks, and the server enforces it. `terminal` opens the member's terminal
 * (`/api/ws/computer-terminal`).
 */
export const COMPUTER_TICKET_PURPOSES = ['view', 'control', 'terminal'] as const;
export type ComputerTicketPurpose = (typeof COMPUTER_TICKET_PURPOSES)[number];

export const computerTicketInputSchema = z.object({ purpose: z.enum(COMPUTER_TICKET_PURPOSES) });
export type ComputerTicketInput = z.infer<typeof computerTicketInputSchema>;

/**
 * A one-time ticket for one socket, good for a minute. Browsers cannot put headers on a
 * WebSocket, so it goes in the socket's URL (`?ticket=`), and nothing else ever carries one.
 */
export const computerTicketSchema = z.object({ ticket: z.string(), expires_at: isoTime });
export type ComputerTicket = z.infer<typeof computerTicketSchema>;

/**
 * Why a computer socket closed, besides 1008 (a message it does not take) and 1011 (the
 * computer ended the stream).
 */
export const COMPUTER_SOCKET_CLOSE = {
  /** The ticket is unknown, used, expired or for the other socket: ask for a new one. */
  ticket: 4401,
  /** The member may no longer use this computer. */
  forbidden: 4403,
  /** The computer is not running: it stopped, or was never started. */
  stopped: 4409,
} as const;

/**
 * The terminal socket's one text message. Keystrokes go as binary messages, and the terminal's
 * output comes back as binary messages.
 */
export const terminalResizeSchema = z.object({
  type: z.literal('resize'),
  cols: z.number().int(),
  rows: z.number().int(),
});
export type TerminalResize = z.infer<typeof terminalResizeSchema>;

/** A path in the Agent's home, relative to it: '' is the home itself, and `..` is refused. */
export const computerPathQuerySchema = z.object({ path: z.string().max(4096).default('') });

export const computerFileSchema = z.object({
  name: z.string(),
  /** A link shows as what it points to. */
  type: z.enum(['file', 'dir']),
  size: z.number().int().min(0),
  modified_at: isoTime,
});
export type ComputerFile = z.infer<typeof computerFileSchema>;

/** One folder of the home: folders first, then files, each by name. */
export const computerFolderSchema = z.object({
  path: z.string(),
  items: z.array(computerFileSchema),
  /** It holds more than the 500 entries listed. */
  truncated: z.boolean(),
});
export type ComputerFolder = z.infer<typeof computerFolderSchema>;

/** Handing the computer back after a take-over: a note the Agent reads when it wakes. */
export const handbackInputSchema = z.object({ note: z.string().trim().max(500).optional() });
export type HandbackInput = z.infer<typeof handbackInputSchema>;
