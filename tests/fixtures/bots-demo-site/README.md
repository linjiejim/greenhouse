# Bots demo site (fixture)

A static "procurement portal" with an email + password login, a TOTP second
step and an orders page, plus `verify.html` — a "verify you are human"
interstitial that only a person can pass (tick the box) on the way to
`report.html`. Used to demonstrate and test the Bots vault, take-over and
human-check flows deterministically, without depending on a real website.

Serve it inside a member's computer (origin `http://localhost:8000`, allowed by
the vault only in development/test):

```bash
docker cp tests/fixtures/bots-demo-site <container>:/home/agent/work/acme
docker exec -u agent -d <container> python3 -m http.server 8000 --directory /home/agent/work/acme
```

Demo account (fictional): `jim@acme.test` / `Greenhouse-Demo-2026!`, TOTP secret
`JBSWY3DPEHPK3PXP`.
