# Build progress and continuation

Repository inspected 2026-10-25: initial commit 4213469 contained only README.md. No application/CI existed. Existing history preserved. Main remains unchanged; merge/release authorization has not been given.

| Milestone | Implementation / evidence                                                                                        | Remaining acceptance                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| M01       | ba7661d, PR #1, Node configuration/health/CI; CI green                                                           | Authorized merge                                                           |
| M02       | 632118a, PR #2, Mongo models/indexes/DTOs/APIs/isolation tested                                                  | Authorized merge                                                           |
| M03       | Nine responsive vanilla pages, real HTTPS auth/session/CSRF and UI tests                                         | VPS accessibility/security acceptance                                      |
| M04       | Profile leases, WSS viewer/TTL, local verification flow and persistent-cookie isolation tested                   | Actual Google/MFA/session reuse UNVERIFIED                                 |
| M05       | New/resumed conversation adapter and saved URLs, fixtures pass                                                   | Current Gemini UI/account identity UNVERIFIED                              |
| M06       | Upload/download validation, one current response image, original bytes + JSON, full fixture worker passes        | Live Gemini output/attachment/download UNVERIFIED                          |
| M07       | Bounded schema-constrained Groq recovery, verified cache and rollback, regression tests                          | Real Groq model/key/schema support UNVERIFIED; optional vision not enabled |
| M08       | FIFO, owner/fence heartbeat leases + OS flock, cancellation/idempotency/recovery tested                          | Live process-kill and full network partition drill UNVERIFIED              |
| M09       | Persistent SSE/events, protected outputs/gallery, current-response-image-only monitor captures and recovery logs | Target VPS/live UI acceptance                                              |
| M10       | Ubuntu/PM2 config, install/backup scripts, architecture/API/security/operations/test report and changelog        | Fresh VPS install/restore/reboot drill and authorized release              |

## GitHub references

- M01: ba7661d — https://github.com/nethsara-rahiru/Image-Genarator/pull/1, two Node 22 CI checks passed.
- Backend M02–M08: 632118a — https://github.com/nethsara-rahiru/Image-Genarator/pull/2, stacked on M01; two CI checks passed at that SHA.
- Dashboard/reliability/handover: feature branch feat/m09-dashboard-handover, stacked on feat/m02-platform. Follow-on PR and final CI references are appended after push.

## Current evidence

Local automated suite: 33 passing tests using actual temporary MongoDB processes and Chromium, plus an opt-in live test that is skipped by default. Node 24.19.0 locally, Node 22 in CI. Syntax/Prettier and shell syntax pass; production npm audit reports zero vulnerabilities after upgrading Sharp. Dashboard fixture previews are CI artifacts; profiles/uploads/outputs/login frames/secrets are not committed. See docs/test-report.md for exact coverage and limitations.

## Continue precisely

1. Fetch and inspect latest feat/m09-dashboard-handover head; run `npm ci`, `npx playwright install --with-deps chromium`, `npm run lint`, `npm test`, production audit and shell syntax checks. Do not rerun real generation unless explicitly opt-in.
2. Inspect PR checks/reviews and this report. Feature branches are stacked: merge #1 into main only when authorized, then retarget/merge #2, then final PR after all required checks/reviews. Do not force-push or bypass branch protection.
3. Deploy only a reviewed immutable commit on an Ubuntu 24.04 VPS following docs/deployment.md. Configure all secrets in the SSH terminal/service environment, never chat. No VPS connection or real credentials exist in this cloud session.
4. Administrator must bootstrap app and interact with Google login/2FA. Complete the target acceptance checklist, including two accounts, actual Gemini/Groq, interrupted jobs, TLS/firewall and restore/reboot drill. Record sanitized evidence.
5. Keep live integrations marked UNVERIFIED until those checks are completed. Do not create v1.0.0 or claim a production release until authorized merge and release gates pass.

## Known engineering limits

Single VPS/shared DATA_DIR only; no distributed browser fencing. File/DB writes are not transactional, so crash orphan files require inspection with services stopped. Display email is an admin-maintained label, not a cryptographic identity verification. New chat records gain a Gemini URL only after first submission. Monitoring intentionally captures only current-response image elements, never full account pages. Groq vision is not enabled. Google restrictions are surfaced, never bypassed.
