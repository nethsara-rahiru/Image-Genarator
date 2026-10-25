# Ubuntu 24.04 deployment runbook

Status: implementation candidate, live Google/Gemini, target VPS and Groq **UNVERIFIED**. Do not treat passing fixtures as production acceptance. No release tag is authorized. Recommended minimum: 2 CPU, 4 GB RAM, SSD, Node 22+, MongoDB 8, one API and one worker. Never run Chromium as root. No Docker required.

1. Review source/PRs and choose an approved commit. Install Node 22 LTS or later from a trusted vendor. Run `sudo bash scripts/install-ubuntu.sh` from the reviewed checkout. It creates a dedicated service account, installs system libraries via Playwright and does not modify firewall or expose ports. It does not install Node/Mongo automatically.
2. Install MongoDB 8 Community and MongoDB database tools following the official Ubuntu 24.04 vendor instructions (https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-ubuntu/). Bind mongod to 127.0.0.1, enable authentication, create a least privilege readWrite user for gemini_agent, and start mongod with systemd. No public 27017. Use an authenticated URI in .env. Never paste it into chat.
3. As gemini-agent: clone the reviewed GitHub branch into `/opt/gemini-agent/app`, run `npm ci`, `npx playwright install chromium`. Install a reviewed PM2 version (`npm install --global pm2` as administrator if needed). `cp .env.example .env; chmod 600 .env`; use an SSH terminal editor to configure URI, `openssl rand -hex 32` session secret, and server-side Groq API key if desired. `DATA_DIR=/opt/gemini-agent/app/runtime`; HOST remains 127.0.0.1.
4. Configure HTTPS even inside an SSH tunnel because authentication cookies require Secure. Option A: a valid TLS certificate in built-in server TLS_KEY/TLS_CERT, PORT=3443, PUBLIC_ORIGIN=https://localhost:3443 (certificate SAN must match localhost and be trusted on your workstation). Option B: loopback Caddy TLS proxy with an internal CA, described below. Do not skip certificate verification or click through warnings as a deployment strategy.
5. `npm run setup-admin` in an interactive SSH terminal. Password entry is hidden; Google passwords are never provisioned here.
6. `npm run lint && npm test`. Tests download temporary Mongo binaries and launch Chromium. Run `pm2 start ecosystem.config.cjs; pm2 save` as gemini-agent, configure `pm2 startup` with its printed systemd instructions as administrator. `pm2 status` should show API and worker. Never scale worker across hosts or use a second runtime directory.
7. From your workstation: `ssh -N -L 3443:127.0.0.1:3443 your-ssh-user@VPS_IP`. Open **https://localhost:3443**. The VPS IP is used for SSH, never plaintext dashboard login. Verify certificate trust and sign in.
8. Add one Google account display email → Connect → interact directly with Google/2FA in the temporary viewer → Verify & finish. If a challenge, blocked login or usage restriction occurs, stop and follow Google's normal process. The platform does not bypass security controls. Confirm the signed-in identity matches the account label.
9. Submit a test prompt with a harmless reference image. Confirm current chat URL, a single original output, metadata dimensions/format/bytes and account isolation. Repeat with a second account, reconnect, restart, cancellation and crash recovery. Record results in docs/test-report.md before approving production use.

## Optional loopback TLS proxy with Caddy internal CA

Install Caddy from its official repository. Keep API PORT=3000 and PUBLIC_ORIGIN=https://localhost:3443. Use a root-owned Caddyfile:

```caddyfile
https://localhost:3443 {
    bind 127.0.0.1
    tls internal
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

Caddy passes X-Forwarded-Proto; Express trusts loopback only. Caddy supports WebSockets and SSE. Do not enable access logging of viewer query strings. Start Caddy; transfer **only its public internal CA root certificate**, usually `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`, to your workstation over SSH. Verify its SHA-256 fingerprint through the SSH terminal. Trust this specific certificate using your OS certificate manager (never copy private keys to your workstation). SSH-forward port 3443 as above. Remove this CA trust when decommissioning. Alternative: a proper domain and valid public TLS with the same proxy configuration, additional firewall review and matching PUBLIC_ORIGIN. Do not expose port 3000.

## Update / rollback

Stop API and worker; take a consistent backup. `git fetch` and checkout an explicitly approved immutable commit; `npm ci`; `npx playwright install chromium`; lint/tests; `pm2 restart ecosystem.config.cjs --update-env`. Verify worker singleton, health and one fixture/live smoke job. Roll back by checking out the prior approved commit and running npm ci. No destructive database migrations currently exist; review future schema changes before rollback. Never git reset unrelated work, force push or run unreviewed installer scripts.
