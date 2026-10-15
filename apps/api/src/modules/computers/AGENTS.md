# Computer lifecycle rules

- Claim capacity under the shared transaction advisory lock; queued_at/id is FIFO. A start claim is persisted before provider work. Worker reconciliation recovers abandoned starting rows.
- Serialize backup, stop, reset and restore per computer. Archive each home as its own uid; never grant the Agent browser access. Encrypt before storage with owner/computer/backup AAD. Authenticate before import and reject unsafe archive entries.
- Backups keep three complete and three failed entries. Reset deletes their storage objects before deleting the row. Losing a sandbox with an intact persistent home must never restore an older backup over it.
- Admin operations enforce active admin status in this service and audit changes. Backup metadata never exposes object keys or ciphertext.
- Operational computer disable keeps queued starts queued and blocks member start/control paths; cleanup remains possible. Worker lifecycle sweeps catch failures and retain the next tick.

- Browser screenshots keep the screen lease and vault checks for every model. Recheck ownership after saving bytes before attaching the image; only vision models receive image context.
