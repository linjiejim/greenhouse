/**
 * A member's mailbox for tests: an IMAP server and an SMTP server on free ports of 127.0.0.1,
 * plain text (the API allows plain mail servers only on loopback outside production). It speaks
 * enough of each for imapflow and nodemailer: LOGIN or AUTHENTICATE PLAIN, LIST, SELECT /
 * EXAMINE, UID SEARCH, UID FETCH (flags, envelope, body structure, the whole message), APPEND
 * and LOGOUT; EHLO, AUTH PLAIN or LOGIN, MAIL, RCPT, DATA and QUIT. Used by the API's tests of
 * the built-in mailbox connector and by the browser tests (fake-llm.mjs starts one).
 */

import { createServer } from 'node:net';

const FOLDERS = [
  { path: 'INBOX', flags: '\\HasNoChildren' },
  { path: 'Sent', flags: '\\HasNoChildren \\Sent' },
  { path: 'Drafts', flags: '\\HasNoChildren \\Drafts' },
];

/** RFC 5322 text of a simple message. */
export function rfc822({ from, to, subject, text, date = new Date('2026-10-14T08:00:00Z'), messageId }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId ?? `<${Math.random().toString(36).slice(2)}@fake.test>`}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    '',
  ].join('\r\n');
}

const quote = (value) =>
  value === null || value === undefined ? 'NIL' : `"${String(value).replace(/(["\\])/g, '\\$1')}"`;

function header(raw, name) {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? '';
  const match = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(head);
  return match ? match[1].trim() : null;
}

function address(value) {
  if (!value) return 'NIL';
  const match = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(value.trim()) ?? [null, null, value.trim()];
  const [mailbox, host] = String(match[2]).split('@');
  return `((${quote(match[1] || null)} NIL ${quote(mailbox)} ${quote(host)}))`;
}

function envelope(raw) {
  return `(${quote(header(raw, 'Date'))} ${quote(header(raw, 'Subject'))} ${address(header(raw, 'From'))} ${address(
    header(raw, 'From'),
  )} ${address(header(raw, 'From'))} ${address(header(raw, 'To'))} NIL NIL ${quote(header(raw, 'In-Reply-To'))} ${quote(
    header(raw, 'Message-ID'),
  )})`;
}

const bodyOf = (raw) =>
  raw
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join('\r\n\r\n');
const structure = (raw) =>
  `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${Buffer.byteLength(bodyOf(raw))} ${bodyOf(raw).split('\n').length} NIL NIL NIL NIL)`;

/** The UIDs a sequence set names (`1:3`, `2,5`, `4:*`), among those that exist. */
function uidsOf(set, existing) {
  const max = Math.max(0, ...existing);
  const wanted = new Set();
  for (const part of set.split(',')) {
    const [from, to] = part.split(':');
    const start = from === '*' ? max : Number(from);
    const end = to === undefined ? start : to === '*' ? max : Number(to);
    for (let uid = Math.min(start, end); uid <= Math.max(start, end); uid++) wanted.add(uid);
  }
  return existing.filter((uid) => wanted.has(uid));
}

/** The words SUBJECT, FROM, TO, BODY or TEXT name (quoted or not), whether any of them is enough, and UNSEEN. */
function criteria(text) {
  const words = [...text.matchAll(/\b(?:SUBJECT|FROM|TO|CC|BODY|TEXT)\s+(?:"((?:[^"\\]|\\.)*)"|(\S+))/gi)].map(
    (match) => (match[1] ?? match[2]).replace(/\\(.)/g, '$1').toLowerCase(),
  );
  return { words, any: /\bOR\b/.test(text), unseen: /\bUNSEEN\b/i.test(text) };
}

/** The two arguments of LIST (reference and pattern), quoted or not. */
const listArgs = (rest) =>
  [...rest.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) => (match[1] ?? match[2]).replace(/\\(.)/g, '$1'));

function startImap(state, track) {
  const server = createServer((socket) => {
    track(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let selected = null;
    let literal = null;
    let pendingAuth = null;
    const send = (line) => socket.write(`${line}\r\n`);
    const messagesIn = (folder) => state.messages.filter((message) => message.folder === folder);
    send('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] Fake IMAP ready');

    const handle = (tag, command, rest) => {
      const upper = command.toUpperCase();
      if (upper === 'CAPABILITY') {
        send('* CAPABILITY IMAP4rev1 AUTH=PLAIN');
        return send(`${tag} OK CAPABILITY completed`);
      }
      if (upper === 'NOOP' || upper === 'CHECK') return send(`${tag} OK done`);
      if (upper === 'LOGOUT') {
        send('* BYE logging out');
        send(`${tag} OK LOGOUT completed`);
        return socket.end();
      }
      if (upper === 'LOGIN') {
        const [user, pass] = [...rest.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) =>
          (match[1] ?? match[2]).replace(/\\(.)/g, '$1'),
        );
        if (user === state.user && pass === state.password) {
          state.logins += 1;
          return send(`${tag} OK [CAPABILITY IMAP4rev1] LOGIN completed`);
        }
        return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
      }
      if (upper === 'AUTHENTICATE') {
        const [, initial] = rest.split(' ');
        const check = (encoded) => {
          const [, user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split('\u0000');
          if (user === state.user && pass === state.password) {
            state.logins += 1;
            return send(`${tag} OK [CAPABILITY IMAP4rev1] AUTHENTICATE completed`);
          }
          return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        };
        if (initial) return check(initial);
        pendingAuth = { tag, check };
        return send('+ ');
      }
      if (upper === 'ENABLE' || upper === 'ID') return send(`${tag} OK done`);
      if (upper === 'NAMESPACE') {
        send('* NAMESPACE (("" "/")) NIL NIL');
        return send(`${tag} OK NAMESPACE completed`);
      }
      if (upper === 'LIST' || upper === 'LSUB') {
        const [reference = '', pattern = '*'] = listArgs(rest);
        // `LIST "" ""` asks only for the hierarchy delimiter.
        if (pattern === '') send(`* ${upper} (\\Noselect) "/" ""`);
        else {
          const wanted = `${reference}${pattern}`;
          const matcher = new RegExp(
            `^${wanted
              .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/%/g, '[^/]*')}$`,
          );
          for (const folder of FOLDERS) {
            if (matcher.test(folder.path)) send(`* ${upper} (${folder.flags}) "/" ${quote(folder.path)}`);
          }
        }
        return send(`${tag} OK ${upper} completed`);
      }
      if (upper === 'STATUS') {
        const path = /^"?([^"\s]+)"?/.exec(rest)?.[1] ?? 'INBOX';
        const inFolder = messagesIn(path);
        send(`* STATUS ${quote(path)} (MESSAGES ${inFolder.length} UIDNEXT ${state.nextUid} UIDVALIDITY 1 UNSEEN 0)`);
        return send(`${tag} OK STATUS completed`);
      }
      if (upper === 'SELECT' || upper === 'EXAMINE') {
        const path = /^"?([^"]+?)"?$/.exec(rest.trim())?.[1] ?? 'INBOX';
        if (!FOLDERS.some((folder) => folder.path === path)) return send(`${tag} NO no such folder`);
        selected = path;
        const inFolder = messagesIn(path);
        send('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
        send(`* ${inFolder.length} EXISTS`);
        send('* 0 RECENT');
        send('* OK [UIDVALIDITY 1] UIDs valid');
        send(`* OK [UIDNEXT ${state.nextUid}] next uid`);
        return send(`${tag} OK [${upper === 'SELECT' ? 'READ-WRITE' : 'READ-ONLY'}] ${upper} completed`);
      }
      if (upper === 'CLOSE' || upper === 'UNSELECT') {
        selected = null;
        return send(`${tag} OK done`);
      }
      if (upper === 'UID') {
        const [sub, ...args] = rest.split(' ');
        const inFolder = messagesIn(selected ?? 'INBOX');
        if (sub.toUpperCase() === 'SEARCH') {
          const { words, any, unseen } = criteria(args.join(' '));
          const hits = inFolder.filter((message) => {
            if (unseen && message.flags.includes('\\Seen')) return false;
            const haystack = message.raw.toLowerCase();
            if (!words.length) return true;
            return any ? words.some((word) => haystack.includes(word)) : words.every((word) => haystack.includes(word));
          });
          send(`* SEARCH${hits.map((message) => ` ${message.uid}`).join('')}`);
          return send(`${tag} OK SEARCH completed`);
        }
        if (sub.toUpperCase() === 'FETCH') {
          const [set, ...items] = args;
          const what = items.join(' ').toUpperCase();
          for (const uid of uidsOf(
            set,
            inFolder.map((message) => message.uid),
          )) {
            const message = inFolder.find((entry) => entry.uid === uid);
            const sequence = inFolder.indexOf(message) + 1;
            const parts = [`UID ${uid}`, `FLAGS (${message.flags.join(' ')})`];
            if (what.includes('ENVELOPE')) parts.push(`ENVELOPE ${envelope(message.raw)}`);
            if (what.includes('BODYSTRUCTURE')) parts.push(`BODYSTRUCTURE ${structure(message.raw)}`);
            if (what.includes('RFC822.SIZE')) parts.push(`RFC822.SIZE ${Buffer.byteLength(message.raw)}`);
            if (what.includes('BODY.PEEK[]') || what.includes('BODY[]')) {
              socket.write(`* ${sequence} FETCH (${parts.join(' ')} BODY[] {${Buffer.byteLength(message.raw)}}\r\n`);
              socket.write(message.raw);
              socket.write(')\r\n');
            } else {
              send(`* ${sequence} FETCH (${parts.join(' ')})`);
            }
          }
          return send(`${tag} OK FETCH completed`);
        }
        if (sub.toUpperCase() === 'STORE') return send(`${tag} OK STORE completed`);
        return send(`${tag} BAD unknown UID command`);
      }
      if (upper === 'APPEND') {
        const match = /^"?([^"\s]+)"?\s+(?:\(([^)]*)\)\s+)?(?:"[^"]*"\s+)?\{(\d+)(\+?)\}$/.exec(rest.trim());
        if (!match) return send(`${tag} BAD append syntax`);
        literal = { tag, folder: match[1], flags: (match[2] ?? '').split(' ').filter(Boolean), size: Number(match[3]) };
        if (!match[4]) send('+ Ready for literal data');
        return undefined;
      }
      return send(`${tag} BAD unknown command ${command}`);
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (literal) {
          if (Buffer.byteLength(buffer) < literal.size + 2) return;
          const bytes = Buffer.from(buffer);
          const raw = bytes.subarray(0, literal.size).toString('utf8');
          buffer = bytes
            .subarray(literal.size)
            .toString('utf8')
            .replace(/^\r?\n/, '');
          const uid = state.nextUid++;
          state.messages.push({ uid, folder: literal.folder, flags: literal.flags, raw });
          send(`${literal.tag} OK [APPENDUID 1 ${uid}] APPEND completed`);
          literal = null;
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end === -1) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (pendingAuth) {
          const { check } = pendingAuth;
          pendingAuth = null;
          check(line.trim());
          continue;
        }
        const [tag, command, ...rest] = line.split(' ');
        if (!tag || !command) continue;
        handle(tag, command, rest.join(' '));
      }
    });
    socket.on('error', () => undefined);
  });
  return server;
}

function startSmtp(state, track) {
  return createServer((socket) => {
    track(socket);
    socket.setEncoding('utf8');
    const reply = (line) => socket.write(`${line}\r\n`);
    let buffer = '';
    let data = null;
    let login = null;
    let user = '';
    let envelope = { from: '', to: [] };
    let authed = false;
    const accept = (credentials) => {
      authed = credentials === `${state.user}:${state.password}`;
      reply(authed ? '235 2.7.0 ok' : '535 5.7.8 bad credentials');
    };
    reply('220 fake.test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (data !== null) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          const raw = buffer.slice(0, end).replace(/^\.\./gm, '.');
          buffer = buffer.slice(end + 5);
          data = null;
          state.sent.push({ ...envelope, raw });
          reply('250 2.0.0 queued');
          envelope = { from: '', to: [] };
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const upper = line.toUpperCase();
        if (login) {
          const decoded = Buffer.from(line, 'base64').toString('utf8');
          if (login === 'plain') {
            login = null;
            accept(decoded.split('\u0000').slice(1).join(':'));
          } else if (login === 'user') {
            user = decoded;
            login = 'pass';
            reply('334 UGFzc3dvcmQ6');
          } else {
            login = null;
            accept(`${user}:${decoded}`);
          }
        } else if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          socket.write('250-fake.test\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
        } else if (upper.startsWith('AUTH PLAIN')) {
          const initial = line.split(' ')[2];
          if (initial) accept(Buffer.from(initial, 'base64').toString('utf8').split('\u0000').slice(1).join(':'));
          else {
            login = 'plain';
            reply('334 ');
          }
        } else if (upper.startsWith('AUTH LOGIN')) {
          const initial = line.split(' ')[2];
          if (initial) {
            user = Buffer.from(initial, 'base64').toString('utf8');
            login = 'pass';
            reply('334 UGFzc3dvcmQ6');
          } else {
            login = 'user';
            reply('334 VXNlcm5hbWU6');
          }
        } else if (upper.startsWith('MAIL FROM:')) {
          if (!authed) reply('530 5.7.0 authentication required');
          else {
            envelope.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
            reply('250 2.1.0 ok');
          }
        } else if (upper.startsWith('RCPT TO:')) {
          envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply('250 2.1.5 ok');
        } else if (upper === 'DATA') {
          data = '';
          reply('354 go ahead');
        } else if (upper === 'RSET' || upper === 'NOOP') {
          envelope = { from: '', to: [] };
          reply('250 ok');
        } else if (upper === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else {
          reply('502 5.5.2 not implemented');
        }
      }
    });
    socket.on('error', () => undefined);
  });
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * Starts a mailbox for `user` / `password` holding `messages` in its inbox. `sent` records what
 * the SMTP side accepted; drafts and anything appended land in `messages` with their folder.
 */
export async function startFakeMailbox({ user, password, messages = [] }) {
  const state = {
    user,
    password,
    logins: 0,
    nextUid: messages.length + 1,
    messages: messages.map((message, index) => ({
      uid: index + 1,
      folder: 'INBOX',
      flags: message.seen ? ['\\Seen'] : [],
      raw: rfc822(message),
    })),
    sent: [],
  };
  // Every open socket, so closing the fake never waits for a client that left one open.
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const imap = startImap(state, track);
  const smtp = startSmtp(state, track);
  const [imapPort, smtpPort] = await Promise.all([listen(imap), listen(smtp)]);
  return {
    state,
    imapPort,
    smtpPort,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return Promise.all([
        new Promise((resolve) => imap.close(() => resolve(undefined))),
        new Promise((resolve) => smtp.close(() => resolve(undefined))),
      ]).then(() => undefined);
    },
  };
}
