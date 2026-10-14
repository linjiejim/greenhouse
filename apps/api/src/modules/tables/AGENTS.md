# Tables Agent work

- All Agent reads and writes use the existing access compiler and record services. Only human-confirmed structure plans change schema.
- Capture automation predicates before a record write and enqueue matched transitions in its transaction. Workers pin the rule revision and recheck run_as and recipients; rules never grant base access.
- Use the tables worker and jobs; no request-context timers. Schedules collapse missed intervals; date values dedupe per rule revision/record/value.
- Webhooks are signed public HTTPS with connect-time DNS checks and no redirects. A sending step left unfinished is uncertain, never replayed. Signing keys are encrypted and shown once, including when first adding a webhook.
- Agent actions deliver events through the engine; carry the source chain through approved writes. No tools by default; granted table_query stays inside the source base. Result fields still use table_mutation approval and original revisions.

- The existing jobs worker also dispatches media_video; handlers still fence writes with the job lease, and media work never uses request-context timers.
- The worker runs only in all/worker roles and also dispatches verified mail_inbound jobs through
  the mail service. Stop admission before awaiting a batch; release unstarted claims on shutdown.
