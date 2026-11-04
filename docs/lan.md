# One-command LAN setup

Both PCs must be on the same Wi-Fi/Ethernet network. No domain, Cloudflare, SSH
tunnel or router port forwarding is needed. The host PC must stay awake. This is
local network access, not public internet hosting.

## On the host PC

Stop any currently running Node app or manually started Caddy, update the repo,
and launch:

```bash
git pull --ff-only
npm ci
node app.js --lan
```

First launch:

1. The app detects a private IPv4 address. If several are available, select the
   Wi-Fi/Ethernet interface connecting the two PCs, rather than a VPN interface.
2. If no dashboard administrator exists, create it in the terminal. Password input
   is hidden. This administrator protects the network dashboard.
3. If Caddy is missing, the app downloads the pinned official release and verifies
   its published checksum before extraction. No Homebrew, sudo or system service
   is needed. An installed Caddy is reused when available.
4. Node stays on loopback behind a managed Caddy HTTPS gateway. LAN mode forces
   dashboard authentication; it does not edit your .env.
5. The terminal prints the dashboard URL, API base URL, public CA certificate file
   and certificate fingerprint. The first API token is shown once in an interactive
   terminal if no active clients exist. Save it securely in Postman; never share it
   in chat. Existing client keys stay valid.

Allow Caddy's incoming network connections if the OS firewall asks. Keep this one
terminal open. Ctrl+C stops both the gateway and app; no second Caddy terminal is
needed. Subsequent launches use `node app.js --lan` and reuse settings and the CA.

## On the second PC: Postman

Transfer only the printed **Studio-LAN-CA.crt** file from the host, for example
using your normal trusted file transfer. Never copy root.key, intermediate keys,
API client stores or the entire runtime folder. Compare the printed certificate
fingerprint if needed to confirm the file came from the host.

In Postman:

1. Settings → Certificates → CA Certificates → enable custom CA certificates.
2. Import Studio-LAN-CA.crt. Keep SSL certificate verification enabled.
3. Set the collection's `baseUrl` to the API address printed by the app, for
   example `https://192.168.1.50:3443/api/v1`.
4. Authorization → Bearer Token → paste your API token locally.
5. Send `GET {{baseUrl}}/health`, then `POST {{baseUrl}}/browser/start`.

The CA import is one-time per host installation. For dashboard access in a normal
web browser, trust that public CA using the OS/browser's certificate settings as
well; Postman's certificate setting does not change browser trust.

Google sign-in still happens manually in Chrome on the host PC. The existing
Linux private virtual display needs separate trusted desktop access for a new
sign-in; LAN setup does not add a browser preview or remote login viewer. Windows
and macOS native browser behavior still requires physical-device validation.

See [client-api.md](client-api.md) for generation, idempotency keys, progress,
chat IDs and image downloads.

## Tokens and settings

To issue another token, use a second terminal in the same project directory:

```bash
npm run api-client -- create "second-pc" read,generate,browser 90
npm run api-client -- list
npm run api-client -- rotate CLIENT_ID 90
npm run api-client -- revoke CLIENT_ID
```

Tokens and settings use the same DATA_DIR as normal mode. LAN state lives under
DATA_DIR/lan, outside the public web directory. Private CA keys remain on the host
and must be protected like browser profiles. Back up that directory securely to
preserve certificate trust; do not commit it. Losing/replacing the CA requires a
new import on the second PC. The .crt file alone contains no private key.

Optional .env settings (or environment variables):

```dotenv
LAN_HOST=192.168.1.50
LAN_PORT=3443
# Optional manually installed Caddy:
# CADDY_PATH=/absolute/path/to/caddy
```

LAN_HOST must belong to a private IPv4 interface currently assigned to the host.
LAN_PORT must be 1024–65535 and differ from the backend PORT (default 3030).
Previously selected LAN address/port are remembered when still available. If the
IP changes, use the newly printed URL. Reserve the host's IP in your router for a
stable address. Keep runtime/lan/pki to preserve the trusted CA.

Native x64/arm64 Windows, macOS and Linux release downloads are supported. Windows
uses its included tar utility. Offline/restricted machines can install Caddy
manually and use CADDY_PATH. Download errors fail closed; HTTPS verification and
checksum checks are never disabled. Normal `node app.js` behavior is unchanged;
`--lan` cannot be combined with Docker `--background`.

## Troubleshooting

- No LAN address: connect Wi-Fi/Ethernet; loopback/public/link-local IPs are rejected.
- Wrong interface: set LAN_HOST or select the address in Wi-Fi/Ethernet settings.
- Port/workspace busy: stop the previous app/Caddy first. After a hard interruption,
  an orphan startup lock can take 30 seconds to expire.
- Postman certificate error: import the printed CA from this host; don't disable
  verification. Ensure the URL uses the printed IP and correct port.
- Connection refused/timed out: keep the host awake, permit Caddy through its
  firewall and avoid guest Wi-Fi/client isolation. No router port forwarding is
  required for same-LAN use.
- API 401: supply a valid, unexpired bearer token. A dashboard password is not an
  API token. Noninteractive startup does not print/create secret tokens; use the CLI.

Automated integration exercises actual Caddy, CA trust, authenticated API access,
restart, unchanged .env and fail-closed startup. Target PC firewall, certificate
import UI, browser permissions and live Google/Gemini require user validation.
