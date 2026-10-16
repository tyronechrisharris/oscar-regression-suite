# Contributing

Keep every scenario deterministic, evidence-producing, and safe to clean up.

Before submitting a change:

```bash
npm ci
npm run check
npm test
npm audit --audit-level=high
```

Live changes must also be run against an authorized emulator-backed deployment.
Start with the smallest affected scenario, then run smoke and full. Preserve a
failed result bundle and distinguish product, environment, and harness failures.

New state-changing scenarios must:

- be restricted to the acknowledged reserved RPM/lane
- snapshot every state they change before mutation
- restore in `finally` and record a cleanup assertion
- use exact event/occupancy correlation rather than matching historical rows
- add unit tests for safety guards and report behavior
- update `docs/COVERAGE.md`, `.env.example`, and the bundled skill when needed

Do not add credentials, private keys, `.env`, result bundles, or downloaded OSCAR
artifacts to Git.
