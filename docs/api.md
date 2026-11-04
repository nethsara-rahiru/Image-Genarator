# Local generator API

For authenticated public/server-to-server clients use the separate
[versioned HTTPS client API](client-api.md), not dashboard session endpoints.

Default base: http://127.0.0.1:3030. No application login is required locally.
Fetch `GET /api/session` first and retain its HttpOnly session cookie. Mutations
require the exact configured `Origin` and returned `csrf` as `X-CSRF-Token`.
Missing/invalid Host or CSRF is rejected. Public no-login origins are rejected by
configuration. Optional `AUTH_REQUIRED=true` enables the legacy protected API.

## Generation

- `GET /api/generation`: retained job summaries, queue positions, active job,
  worker busy flag and saved chats. Account fingerprints/private storage paths
  are excluded.
- `POST /api/generation/jobs`: returns 202 with a job ID immediately. Body:
  `{ "prompt": "description", "chatId": null, "idempotencyKey": "unique-key-0001" }`.
  Prompt: 1–8000 characters. `chatId=null` creates a chat; otherwise select an ID
  already in this workspace. Idempotency keys: 8–128 ASCII letters/digits/`_`/`-`.
  Reusing a key with identical prompt/chat returns the same job; conflicting
  content is rejected. Finish/cancel an active sign-in assistant first.
- `GET /api/generation/jobs/:id`: current full local job details. `chatId` remains
  null until Gemini's real conversation URL is observed.
- `POST /api/generation/jobs/:id/cancel`: cancel queued/running work. A submitted
  Google prompt cannot be undone; cancellation never silently resubmits it.
- `POST /api/generation/jobs/:id/recover`: download-only recovery for an existing
  download-stage failure. Opens the same chat/account and requires a unique image
  fingerprint or, for older jobs, a unique exact prompt/response pair. Never fills
  the composer or submits a prompt. `canRecoverDownload` controls its dashboard action.
- `POST /api/generation/jobs/:id/retry`: explicit retry only when submission
  could not have occurred. Submitted/ambiguous/completed prompts are not replayed.
- `DELETE /api/generation/jobs/:id`: remove a terminal local job/output, preserving
  the remote Google conversation. Cancel active work before removing it.
- `PATCH /api/generation/chats/:id`: `{ "title": "Local title" }`, 1–100 chars.
  Renames the local catalog only.
- `GET /api/generation/jobs/:id/image`: completed original PNG/JPEG/WebP bytes;
  `?download=1` sends an attachment. No incomplete/invalid image is returned.
- `GET /api/generation/jobs/:id/metadata`: metadata JSON attachment, including job
  ID, real chat ID/URL, opaque account reference, user/submitted prompts, original
  filename, actual width/height/format/content type/bytes/checksum and timestamps.

States: queued, running, preparing_prompt, submitting_prompt, generating,
downloading, completed, failed, needs_login, needs_review, cancelled. Queue is
FIFO by sequence with one worker lease per data directory. Retry moves a safe
job to the queue tail. Restart marks potentially submitted work needs_review.

## Existing browser/sign-in services

`GET /api/state`, `POST /api/action`, `POST /api/upload`,
`GET /api/downloads`, `GET/DELETE /api/downloads/:id`, `GET /api/health`,
`GET /api/logs`, `GET /api/logs/export`, `DELETE /api/logs` remain available.
Manual browser input and upload are blocked while a generation job owns Chrome.

`GET/POST /api/gemini-flow` controls observed sign-in; commands start, proceed,
and cancel. The legacy input command is rejected with HTTP 400; enter all Google
credentials directly in Chrome.
`GET/POST /api/automation/settings` reads/saves Groq configuration; keys are never
returned. These endpoints retain origin/session/CSRF safeguards without requiring
a local administrator password.

The same-origin `/stream` WebSocket sends browser state, sanitized
logs, sign-in steps and versioned `generation` snapshots. The client refreshes
state after reconnect and uses HTTP refresh if the stream is unavailable.
