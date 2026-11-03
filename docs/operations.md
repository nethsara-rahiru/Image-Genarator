# Local operations

Run `npm ci` then `node app.js`; use `node app.js --background` with Docker for an
isolated Linux desktop. The default local dashboard requires no app password.
Google authentication is separate. Configure an ordinary signed-in profile using
**Open Gemini / sign in**, completing sign-in directly in Chrome, then **Check again**. Stop on Google security/account/limit
rejection; do not change accounts or browser security to work around restrictions.

## Jobs and recovery

Only one generation runs at a time. A lease protects the on-disk queue and a
separate lock protects the Chrome profile. While a job owns Chrome, use its Cancel
button before manual controls. Cancel stops waiting/downloading but does not undo
a Google prompt. A safe pre-submission job can be explicitly retried; ambiguous
or submitted jobs require inspecting the recorded Gemini chat instead.

On restart, queued jobs resume in FIFO order; interrupted submitted jobs become
needs_review. Do not delete the journal to retry them. A missing login becomes
needs_login; connect the account and explicitly retry. A text-only response is a
failed no-image job with its observed chat ID preserved. Unknown UI, output
association, interrupted downloads and timeouts require review rather than
invented outputs or automatic resubmission.

A queue/profile-busy startup error means another app owns the workspace. Stop the
other verified instance; never kill an unrelated Chrome process or delete its
profile. After an abrupt browser crash, inspect the dedicated recorded PID and
`npm run doctor` before closing an orphan managed browser. Account mismatch on
resume requires restoring that account or creating a new chat.

## Storage and backups

Stop the app before copying `DATA_DIR` (default runtime). Background mode uses
`DATA_DIR/background`. Back up the entire directory to preserve profiles, queue,
chat references and outputs together. Restore to a private directory owned by the
service user; use mode 700 for directories/600 for private files or equivalent
Windows ACLs. Backups include prompts, Google sessions and Groq keys: protect them.

The generation journal is `generation/queue.json`; files are under
`generation/outputs/<job-id>/`. Deleting a terminal job from the dashboard deletes
only that job's local files, not the Google conversation. History defaults to
500 records and at most 50 pending jobs. Images are limited to 100 MB; generation
has a configurable 180-second timeout. Browser partials, logs and profiles still
need disk monitoring/OS quotas. Do not edit a live journal; corrupted storage
fails closed without overwriting the original.

## Updates

Stop the app, keep a backup, `git pull --ff-only`, `npm ci`, restart. Docker mode
rebuilds its image from source and preserves the background data mount. Old admin
files remain untouched but are ignored in the default no-login mode.

Set `PUBLIC_ORIGIN=http://127.0.0.1:3030` and `AUTH_REQUIRED=false` for local use.
Use an encrypted SSH tunnel from another trusted device. No-login public origins
are deliberately rejected. Optional protected TLS access is documented separately;
never expose the shared local browser/profile through public plaintext HTTP.

For diagnostics use Debug console or `npm run doctor`. Logs exclude prompts,
credential values and page text; job metadata intentionally contains user prompts.
Google/Gemini/Groq and physical-device integrations need live acceptance as listed
in docs/test-report.md; fixture results do not establish those services work.
