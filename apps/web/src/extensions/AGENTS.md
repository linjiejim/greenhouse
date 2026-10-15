# Web extensions

- Only index.ts imports implementations. Match API extension ids and surface ids; the authenticated manifest controls activation.
- Compose the kit with design tokens and zh/en copy. Use the shared contract client, never raw fetch or a second token store.
- Admin sections require admin in both host and services. Entity data always rechecks access in its API service.
- Verify every contributed page, setting and panel in the browser, including dark and 390 px.
