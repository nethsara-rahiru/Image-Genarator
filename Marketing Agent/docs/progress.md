# Promotion generation implementation

- Scope: Marketing Agent folder only. Existing root image generator unchanged.
- Promote now queues a Mongo-backed four-image workflow instead of opening the
  draft composer. Groq writes each prompt; the existing Image-Genarator API
  accepts multipart reference images and returns a durable remote job ID.
- Poll each remote job; validate/decode its original image and save original
  bytes to MongoDB GridFS. Preserve partial successes. Show actual prompts,
  stages, errors, completed images and downloads in the owner dashboard.
- Queue uses an expiring global MongoDB lease, heartbeat and worker ownership
  fence. Restart reuses saved prompt, references and idempotency key. Ambiguous
  failures stop for review; never invent a new retry request automatically.
- backend/.env is created locally, mode 0600, excluded from Git. setup-env creates
  it on other machines without overwriting existing settings; example is committed.
- Validation: 12 backend tests passed (0 skipped) against real MongoDB 8,
  local Groq/image-service HTTP fixtures and Chromium. Covers end-to-end Promote,
  exact reference bytes, four sequential requests, GridFS downloads, owner access,
  duplicate submissions, concurrent workers, expired leases, restart between
  submission and ID persistence, partial failures, login/no-image, malformed Groq,
  corrupt images, bounded timeout, cancellation, changed provider configuration,
  and responsive four-column desktop / mobile layout.
- Existing root suite: 77 passed, 5 explicitly skipped, 0 failed locally.
  Root lint passed. Backend production dependency audit: zero vulnerabilities.
- Live Groq/Gemini integrations are UNVERIFIED: configure backend/.env, run the
  image generator, sign in to Google manually on its host, then click Promote.
- No public image URLs, provider secrets in frontend responses, automatic social
  publishing, or runtime reference/output files were committed. Back up the whole
  database including GridFS and monitor storage; see README for limits and cleanup.
- Continuation: inspect PR/CI for feat/marketing-promotion-generation. Merge to
  main only after checks pass (already authorized by the user). Do not modify
  files outside Marketing Agent/ for this task.

## Image API HTTPS certificate support

- Only Marketing Agent files changed. Image-generator application, Caddy,
  browser code and certificates are untouched.
- Load IMAGE_API_CA_FILE (absolute, ~/ or backend-relative), inline PEM through
  IMAGE_API_CA_CERT, or existing NODE_EXTRA_CA_CERTS directly into a scoped
  image-API TLS agent. Works after dotenv loading with normal npm start/dev.
- Include public/default and available OS trust roots; Postman's private trust
  settings remain separate. No TLS verification bypass. Close agents after each
  promotion and retain chain, hostname/IP and expiry checks.
- npm run check-image-api checks HTTPS/authentication and browser status without
  starting Chrome or submitting an image. Classify issuer, hostname, expiry,
  refusal, DNS and timeout errors; redact raw errors and all credentials.
- Validation: full backend suite 22 passed, zero skips on MongoDB 8/Chromium;
  real HTTPS certificate suite 9 passed on Node 22. Includes late dotenv CA path,
  file and inline PEM, multipart generation/poll/download, read-only diagnostic,
  wrong hostname, untrusted issuer, private-key rejection and Groq trust isolation.
  Production dependency audit: zero vulnerabilities. Root lint required before
  merge; root source files must stay unchanged.
- Real macOS Keychain/Postman certificate and the user's live image API remain
  UNVERIFIED until npm run check-image-api is run on the laptop.
- Continue in PR #38 (fix/marketing-upstream-diagnostics), now including TLS fix.
  Merge only after current checks pass; user has already authorized main merges.
