# Connector catalog

The official, vetted list of remote MCP servers a Greenhouse administrator can install with one click
(Administration → MCP Servers → **Add from catalog**). Members then use them from chat and from their
Bots — public ones right away, the ones that work with each member's own account after the member
connects (Settings → **Connectors**).

Each file here is one connector. Adding a file is how you contribute one.

## Format

A catalog file is an [official MCP Registry `server.json`](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md)
— the Registry's own schema, so an entry can be copied from or submitted to the Registry unchanged —
plus Greenhouse's fields under its own `_meta` key, the way a downstream registry is meant to extend it.

```jsonc
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "app.linear/linear",            // the Registry name when the server is listed there
  "title": "Linear",
  "description": "Find, create and update Linear issues, projects and comments.", // ≤ 100 chars, shown to the model
  "version": "1.0.1",
  "websiteUrl": "https://linear.app/docs/mcp",
  "remotes": [{ "type": "streamable-http", "url": "https://mcp.linear.app/mcp" }],
  "_meta": {
    "com.linjiejim.greenhouse/connector": {
      "slug": "linear",                    // what the agent calls it: lowercase, ≤ 32
      "category": "productivity",          // docs | dev | productivity | data | maps | search | other
      "title_zh": "Linear",
      "description_zh": "……",              // shown in the Chinese UI
      "auth": { "mode": "oauth", "zero_config": true },
      "read_only_tools": [],               // tools you checked only read, though the server does not say so
      "verification": { "level": "sign_in", "date": "2026-10-09", "notes": "…" }
    }
  }
}
```

### `auth`

| `mode` | Meaning | Extra fields |
|---|---|---|
| `none` | A public server: nothing is sent. | — |
| `oauth` | Each member signs in with their own account (MCP authorization spec: OAuth 2.1 + PKCE). | `scope` (optional) |
| `per_user` | Each member pastes their own key or token. | `header` **or** `query_param`, optional `prefix` (e.g. `"Bearer "`), `help` + `help_zh` (what to paste), `help_url` |

`zero_config` is `true` when members can connect without the administrator registering anything at
the provider: always for `none` and `per_user`; for `oauth` only when the provider supports dynamic
client registration or client-id metadata documents. GitHub, for example, supports neither — its entry
uses `per_user` with a personal access token instead.

### `read_only_tools`

Tools not marked read-only (`readOnlyHint`) by their server ask before they run: a confirmation in
chat, an approval card in Bots. List a tool here only if you verified that it never changes anything
(DeepWiki's tools, for instance, only read public repositories but carry no annotation). A server that
calls a tool destructive overrides this list.

### `verification`

Say how far you checked the entry against the live server — the catalog never claims more:

| `level` | What was checked |
|---|---|
| `call` | Connected and called a tool. |
| `sign_in` | OAuth discovery and client registration worked up to the provider's consent page. |
| `handshake` | The server answered; calling it needs a key or account the contributor did not use. |

## Contributing a connector

1. Only **remote** servers (Streamable HTTP, or SSE where that is all there is). Greenhouse never starts
   local processes for a connector.
2. Prefer the vendor's own endpoint on the vendor's own domain. Many Registry entries are proxies or
   look-alikes of a well-known service — they do not belong here.
3. Use the Registry `name` when the server is listed there; otherwise the vendor's reverse domain.
4. Fill in `verification` honestly and give the date you checked.
5. Run the catalog check: `pnpm vitest run apps/api/src/mcp-client/__tests__/catalog.test.ts`.

Credentials never go in a catalog file — per-member keys are pasted by each member in Greenhouse, and
OAuth clients are registered by each Greenhouse instance for itself.
