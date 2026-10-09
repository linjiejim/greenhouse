-- Bots group chats are retired (2026-10-09). A conversation is a Bot's DM; other
-- Bots join it as guests (a Bot's team.add, or the member's invite) and hand-offs
-- are always allowed. Existing group conversations stay as read-only history, so
-- this is data-only and data-preserving: no row is deleted, no column dropped.
--
-- 1. Every still-pending card of a group conversation is withdrawn, the way the
--    API withdraws a card that can no longer take effect (status 'canceled', the
--    reason in `result`): nothing runs in a group any more, so it could never be
--    carried out, and it would keep asking under "needs you" forever.
UPDATE "bot_requests" AS r
SET "status" = 'canceled',
    "result" = '{"decision":"group_closed"}',
    "updated_at" = now()
FROM "bot_conversations" AS c
WHERE c."session_id" = r."session_id"
  AND c."kind" = 'group'
  AND r."status" = 'pending';
--> statement-breakpoint
-- 2. The Bot-to-Bot switch is gone: the column stays (old clients read the
--    field; the API always reports true) and every row now says so too.
UPDATE "bot_conversations" SET "allow_bot_chat" = true WHERE "allow_bot_chat" = false;
