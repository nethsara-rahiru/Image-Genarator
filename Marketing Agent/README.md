# Marketing Agent

Node.js 22+, Express, MongoDB/Mongoose and vanilla HTML/CSS/JavaScript.
The owner-only **AI Agent** page lists your business name/logo and products.
Click **Promote** to generate four promotional images using Groq for prompts
and your existing Image-Genarator API for image creation.

## Setup

1. Start MongoDB locally or use an Atlas database.
2. In `Marketing Agent/backend`:

   ```sh
   npm ci
   npm run setup-env
   ```

   This creates a private `.env` with a random JWT secret without overwriting
   an existing file. `.env` is ignored by Git; `.env.example` is the safe template.
   Edit `.env` locally and set:

   ```dotenv
   PORT=3000
   MONGODB_URI=mongodb://127.0.0.1:27017/marketing_agent
   GROQ_BASE_URL=https://api.groq.com/openai/v1
   GROQ_API_KEY=YOUR_GROQ_KEY
   GROQ_MODEL=llama-3.3-70b-versatile
   IMAGE_API_BASE_URL=http://127.0.0.1:3030/api/v1
   IMAGE_API_KEY=YOUR_IMAGE_GENERATOR_BEARER_TOKEN
   ```

   Keep the generated JWT_SECRET. Never paste keys into the frontend or commit
   them. Backend loads this file relative to its own directory, independent of
   your working directory. For a private HTTPS image API, configure its public
   CA certificate below; Marketing Agent loads it directly, so normal `npm start`
   and `npm run dev` work without extra Node startup flags.

3. Run the existing Image-Genarator application separately. Its API must support
   `POST /generations`, multipart `references`, job polling and binary image
   downloads. In that application's folder, create a server-side token:

   ```sh
   npm run api-client -- create "marketing-agent" read,generate,browser 90
   ```

   Store the token in `IMAGE_API_KEY`. The base URL must end in `/api/v1`.
   HTTP is allowed only for loopback; use HTTPS between different computers.
   Sign in to Google manually in the image-generator computer's Chrome window.
   Marketing Agent never automates login or collects Google passwords.

4. Back in `Marketing Agent/backend`:

   ```sh
   npm start
   ```

   Open `http://localhost:3000`, sign in as a business owner, save a business
   profile/logo, add products if needed, and open **Menu → AI Agent**.
   Root image-generator files are unchanged by this feature.

## Promote workflow

- Business promotion sends the saved business logo as its reference. Product
  promotion sends the product image and the business logo when available.
  Upload a PNG/JPEG/WebP reference before starting. No arbitrary asset URLs.
- Promote queues a durable MongoDB job and returns immediately. Groq writes a
  detailed prompt using the selected business/product details and preferences.
  Four fixed concepts guide variety: studio hero, lifestyle, editorial and minimal.
- For each variation, submit one multipart generation request, poll its status
  every three seconds by default, download its original image, validate it, and
  save binary bytes in MongoDB GridFS with dimensions, MIME type and checksum.
  Only then start the next variation. Maximum four saved images per promotion.
- Page refresh/polling shows real stages, remote job IDs, prompts, saved images
  and original-image downloads. Work continues if you close the page. Results
  are owner-scoped and remain available after app restart.
- Groq receives business/product text and preferences, not credentials or image
  bytes. Reference images go to the configured image generator. Calls may incur
  provider charges. No social publication or automatic post approval occurs.

### Failure and recovery

A failed image, timeout, invalid Groq response or required Google login stops the
promotion; already saved images are kept. The page shows a sanitized error and
remote job IDs. Inspect that job in the image-generator application before starting
another promotion. There is no automatic fresh-prompt retry after an ambiguous
submission. Cancel stops further local steps; a remote request already submitted
may still finish and consume credits.

A MongoDB global lease with heartbeat serializes promotion workers across backend
instances. Restart resumes pending jobs with the saved prompt, reference snapshot,
remote job ID and deterministic idempotency key. This relies on the configured
image API honoring its existing Idempotency-Key contract. Changing its URL/token
stops older runs to avoid submitting them into a different job namespace. API
requests are bounded; a service/network failure surfaces rather than retrying forever.
The image generator separately owns its global browser queue.

Configuration defaults in `.env.example`:

| Variable                       | Default    | Purpose                                                                      |
| ------------------------------ | ---------- | ---------------------------------------------------------------------------- |
| `IMAGE_API_AUTO_START`         | `true`     | Calls browser/start before the first new image; requires browser token scope |
| `PROMOTION_POLL_MS`            | `3000`     | Poll interval (1000–30000 ms)                                                |
| `PROMOTION_REQUEST_TIMEOUT_MS` | `30000`    | Timeout per HTTP request                                                     |
| `PROMOTION_IMAGE_TIMEOUT_MS`   | `900000`   | Overall limit for each image including prompts and queue waiting             |
| `PROMOTION_MAX_IMAGE_BYTES`    | `20971520` | Maximum downloaded image bytes (20 MiB default)                              |

MongoDB collections: existing users/profiles/posts, products, promotionruns,
promotionLeases, promotionImages.files and promotionImages.chunks. Back up the
entire database so image chunks and run records stay together. No automatic image
retention/deletion is enabled. Monitor database size; GridFS keeps large images
outside MongoDB's 16 MiB document limit. Abrupt termination during an upload can
leave orphan GridFS chunks/files; review and remove only unreferenced data during
maintenance. Normal successful outputs are linked from their promotion run.

## APIs

All APIs below use the existing signed-in owner session cookie, not Groq/image
API keys. Other owners' records and images return 404.

| Method | Endpoint                            | Input / output                                                                                                         |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/products?limit=20&offset=0`   | `{products,total,limit,offset}`; limit 1–100                                                                           |
| POST   | `/api/products`                     | `{name,description,image}` → 201 `{product}`; image is a PNG/JPEG/WebP base64 data URL, max 400000 characters          |
| DELETE | `/api/products/:id`                 | Remove owned catalog item; existing promotion reference snapshots are retained                                         |
| POST   | `/api/promotions`                   | `{targetType:"business"}` or `{targetType:"product",productId}`; required `Idempotency-Key` header → 202 `{promotion}` |
| GET    | `/api/promotions?limit=5&offset=0`  | `{promotions,total,limit,offset}`; limit 1–50                                                                          |
| GET    | `/api/promotions/:id`               | `{promotion}` with real progress, prompts, remote job/chat references and image URLs                                   |
| POST   | `/api/promotions/:id/cancel`        | Stop remaining images, retain completed images                                                                         |
| GET    | `/api/promotions/:id/images/:index` | Original saved image; index 1–4, add `?download=1` for attachment                                                      |
| POST   | `/api/posts/draft`                  | Existing text-only draft API remains supported; separate from generated promotions                                     |

Example submission (use the signed-in session's cookie jar):

```sh
curl -b cookies.txt -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: campaign-tea-0001' \
  -d '{"targetType":"product","productId":"YOUR_PRODUCT_ID"}' \
  http://localhost:3000/api/promotions
```

Reuse a key for the same submission after a connection problem. A different
key starts a separate promotion. Reusing a key for another target returns 409.
At most five pending promotions per owner are accepted at the API precheck.
Missing provider configuration returns 503 before queuing. Missing reference
returns 422. Requests without owner access return 401/403.

A promotion response includes `id`, `targetName`, `state`, `completed`, `total:4`,
`current`, `error`, and four `items`. Completed items contain `imageUrl`, `prompt`,
`remoteJobId`, `chatId`, `chatUrl`, `contentType`, `width`, `height`, `bytes`,
`checksum` and `completedAt`. No API keys, private reference bytes or GridFS IDs
are exposed. States: queued, prompting, submitting, generating, downloading,
completed, failed, needs_login, needs_review, cancelled.

Existing account APIs: POST `/api/auth/signup`, `/login`, `/logout`;
GET `/api/auth/me`; PATCH `/api/account`; GET/PUT `/api/profile`;
GET `/api/businesses` and existing `/api/posts` draft/review endpoints.

## Tests and limitations

Install root dependencies for the Playwright browser harness and backend dependencies.
With a disposable MongoDB and Chromium executable:

```sh
TEST_MONGODB_URI=mongodb://127.0.0.1:27017 TEST_CHROME=/usr/bin/google-chrome npm test --prefix 'Marketing Agent/backend'
```

Tests use uniquely named test databases, actual HTTP clients against local Groq
and generation fixtures, real GridFS image storage and Chromium UI interaction.
They cover references, four sequential images, scoped downloads, restart/
idempotency/worker isolation, manual login, no-image responses, malformed Groq,
invalid downloads, timeout and cancellation. Integration tests explicitly skip
without TEST_MONGODB_URI. They do not call paid/live services.

**UNVERIFIED:** real Groq credentials/model availability and live Gemini generation
on your host. Add your keys locally and complete one real promotion to validate
those integrations. Google may reject automated browsers, ask for sign-in or
return no image; four successful images cannot be guaranteed. The image backend
must stay running and signed in while promotions execute.

### HTTP 403 after Groq creates a prompt

Groq and image generation use separate credentials. With auto-start enabled, the
first image API call is `/browser/start`, which requires the `browser` token
scope. Create the image API token in the root Image-Genarator folder using
`npm run api-client -- create "marketing-agent" read,generate,browser 90`, set it
as `IMAGE_API_KEY` in backend/.env and restart Marketing Agent. `generate` is
needed to submit jobs and `read` to poll/download. If you intentionally use a
read,generate token, set `IMAGE_API_AUTO_START=false` and start the image-generator
browser manually first.

A 403 can also come from Host, HTTPS or proxy access restrictions. Use the
image server's configured address in `IMAGE_API_BASE_URL` (including `/api/v1`).
Errors now identify browser start, submission, status or download and recognize
known scope/Host/TLS errors. Arbitrary upstream response text is not exposed.
After resolving the configuration, start a new promotion; inspect any existing
remote job before repeating a promotion that had already submitted an image.

## Private HTTPS certificates (Postman, Mac and other PCs)

Postman has its own certificate settings. A CA trusted only inside Postman is
not automatically trusted by Node. Export or locate the **public CA certificate**
you selected in Postman; no private key or Google credentials are needed. If the
CA is already trusted in the operating system (for example macOS Keychain),
Marketing Agent also includes system roots on Node versions that expose them.
On older Node 22 releases, use the explicit file or PEM setting below.

Choose one option in `backend/.env`:

```dotenv
# Recommended: the same public CA file you imported into Postman.
IMAGE_API_CA_FILE="/Users/nethsara/certificates/image-generator-root.crt"
```

Paths may be absolute, start with `~/`, or be relative to `backend/` (including
when launched from another working directory). Multiple CA certificates in one
PEM bundle are supported. Existing `NODE_EXTRA_CA_CERTS=/path/to/root.crt` settings
in `.env` are supported as a fallback; `IMAGE_API_CA_FILE` takes precedence.

Alternatively paste the public PEM directly in `.env`, inside double quotes:

```dotenv
IMAGE_API_CA_CERT="-----BEGIN CERTIFICATE-----
PASTE_THE_REAL_PUBLIC_CA_CERTIFICATE_BASE64_HERE
-----END CERTIFICATE-----"
```

The text above is a placeholder, not a working certificate. Use the entire
exported PEM. Literal `\n` escapes between PEM lines also work. File and inline
certificates can be combined. Never paste a private key. Local copies can go in
`backend/certificates/`, which is ignored by Git; `.env` remains ignored too.

Restart Marketing Agent after changing the certificate, then run in `backend/`:

```sh
npm run check-image-api
npm run dev
```

The check uses the same TLS trust and authentication as generation. It reads
health/browser status only: no browser start, prompt submission or image charge.
It prints static diagnostics, never keys or arbitrary upstream response text.

Custom CAs apply only to image-API connections; Groq's global TLS trust is
unchanged. TLS chain, hostname/IP and expiry verification remain enabled. Do
not set `NODE_TLS_REJECT_UNAUTHORIZED=0` or turn off SSL verification in Postman.
If Postman worked only because verification was disabled, obtain the correct
public CA instead. A CA cannot fix an expired certificate or hostname mismatch;
use the HTTPS hostname/IP listed in the image server's certificate.

Missing/invalid PEM gives `PROMOTION_TLS_CONFIG`; issuer/name/expiry problems give
`UPSTREAM_TLS`; connection refused, DNS and timeout failures have distinct guidance.
This change does not modify the image generator, its Caddy settings or certificates.

Certificate tests use a real local HTTPS service and generated test CA. They
verify custom trust for start/submission/status/original download, inline/file
PEM, late dotenv loading, rejection of unknown issuers/wrong hostnames, isolation
from Groq trust and redaction. Actual macOS Keychain/Postman export and your
specific live certificate remain unverified until checked on your laptop.
