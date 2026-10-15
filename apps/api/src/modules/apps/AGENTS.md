# Apps rules

- One base per app. Audience grants in `shares` never grant base access; app roles and card queries narrow the tables access compiler through `withBaseRestriction`.
- Card columns project the readable values; they do not hide computed dependencies. Linked titles still use the intersection of app and base roles on the target table.
- Runtime accepts saved card/action ids and a published version, never client specs or button values. Writes lock the app against publication and use tables.records with the member and `app_id` history.
- Published specs are immutable. Publishing consumes the draft revision; restoring changes only the draft.
- Templates contain schema and published pages, no live records, shares or automations. Install through tables services with fresh references and computed dependencies. Only approved versions install; admin review is audited.
- Custom code runs only after admin review of that exact immutable version/hash. Pending/rejected and draft previews omit HTML. The source-checked read bridge only queries declared same-app table cards; never bind external connector data or permit writes.
- External cards use connectors.readCard with the viewer’s personal connection and read-only tool policy. Cache hits recheck connection/connector revisions. JSON Pointer maps return scalars only. Agent tools and scoped MCP reuse this gateway.
