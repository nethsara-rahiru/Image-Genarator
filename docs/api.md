# API

All requests use the configured HTTPS origin. Cookies are HttpOnly, Secure, SameSite=Strict; session lifetime is one hour with rolling activity. `GET /api/auth/me` provisions a CSRF token even before login. Mutations need same-origin `Origin` and `X-CSRF-Token`; login regenerates session and returns a new CSRF token. Auth errors are 401; input errors 400; conflicts 409; HTTPS violations 426. JSON error shape: `{error:{code,message}}`. No public admin setup endpoint; use CLI.

Lists accept `page` (1 based), `limit` (1–100), return `{items,total,page,limit}`. `_id` is the record identifier. IDs are validated ObjectIds. Dates are ISO strings. Unknown body properties are rejected.

| Method           | Path                          | Body / behavior                                                                                                      |
| ---------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET              | /api/health                   | DB availability; no admin needed, HTTPS required                                                                     |
| GET              | /api/auth/me                  | authenticated, csrf                                                                                                  |
| POST             | /api/auth/login               | username, password; rate limited                                                                                     |
| POST             | /api/auth/logout              | destroy session                                                                                                      |
| POST             | /api/auth/password            | currentPassword,newPassword (14+); invalidates sessions                                                              |
| GET/POST         | /api/accounts                 | list / `{email}` display identity                                                                                    |
| GET/PATCH/DELETE | /api/accounts/:id             | inspect / `{disabled}` / `{confirm:true}` permanently removes profile                                                |
| POST             | /api/accounts/:id/login       | temporary viewerUrl and expiresAt                                                                                    |
| POST             | /api/accounts/:id/verify      | verify active login and close it, or launch headless verification                                                    |
| POST             | /api/accounts/:id/login/close | close active viewer without verification                                                                             |
| GET              | /api/accounts/:id/status      | stored verification state                                                                                            |
| GET/POST         | /api/chats                    | filter accountId / `{accountId,title}` pending local record                                                          |
| GET/PATCH/DELETE | /api/chats/:id                | inspect / `{title}` / `{confirm:true}` archive locally                                                               |
| POST             | /api/assets                   | multipart files, max 5 × 10 MB; returns asset IDs                                                                    |
| POST             | /api/generate                 | `{accountId,chatId?,createNew,prompt,assetIds}`; `Idempotency-Key` header 8–128 chars; returns job immediately (202) |
| GET              | /api/jobs                     | filters state,accountId; queuePosition for queued jobs                                                               |
| GET              | /api/jobs/:id                 | job and first 200 events                                                                                             |
| POST             | /api/jobs/:id/cancel          | cancellation request; ambiguous submission needs review                                                              |
| POST             | /api/jobs/:id/retry           | optional `{confirm:true}` required after submission boundary; bounded retries                                        |
| GET              | /api/outputs                  | gallery metadata                                                                                                     |
| GET              | /api/outputs/:id              | record metadata                                                                                                      |
| GET              | /api/outputs/:id/image        | image; `download=1` adds attachment header                                                                           |
| GET              | /api/outputs/:id/metadata     | lightweight JSON attachment                                                                                          |
| DELETE           | /api/outputs/:id              | `{confirm:true}` delete original + JSON                                                                              |
| GET              | /api/events                   | authenticated SSE; Last-Event-ID or after query for replay                                                           |
| GET              | /api/worker/status            | online lease, heartbeatExpiry, activeJob, profile count                                                              |
| GET              | /api/overview                 | counts and recent events                                                                                             |
| GET              | /api/recovery                 | locator pagination and latest 100 recovery events                                                                    |
| POST             | /api/recovery/:id/rollback    | previous verified selector                                                                                           |
| GET/PATCH        | /api/settings                 | public configuration indicators / timeout,retryLimit,retentionDays,groqEnabled,groqModel                             |

`wss://ORIGIN/viewer?account=ID&csrf=TOKEN` additionally requires authenticated session and exact Origin. It exists only while the account login session is active. Do not log query strings. The token is a CSRF token rather than a password, but treat it as sensitive. Browser UI links must originate from authenticated dashboard.

Example generation body: `{ "accountId":"OBJECT_ID", "createNew":true, "prompt":"Create a blue geometric icon", "assetIds":[] }`. Use `createNew:false` with an existing chatId. Create-new pending chat records materialize when the worker opens the first generation.

`POST /api/chats/:id/open` opens a saved active chat in a temporary authenticated remote viewer under its account profile lock. Verify & finish closes that viewer.

Login lifecycle: `GET /api/accounts/:id/login/status` returns active, expiresAt, remainingMs, or an inactive reason. `POST /api/accounts/:id/login/gemini` opens the fixed Gemini URL in the active login browser after the admin completes Google sign-in. Failed interactive verification returns `{ready:false,active:true,message,...}` and preserves the browser. Successful verification closes it. `LOGIN_SESSION_MS` sets the bounded login lifetime (60000–1800000 ms; default 900000). Viewer transport reconnects reuse the same context and profile lock.
