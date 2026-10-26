# Deployment and operations

## Replace the old application

This rebuild removes the previous Gemini platform source. It preserves Git history and does not delete Mongo Atlas data or runtime profiles. It uses a **new** administrator in `DATA_DIR/admin.json`; provision it with `npm run setup-admin`. Existing Atlas credentials are not used. You can retain old runtime data in a private offline backup. Do not publish it.

With the former application idle, stop its services before starting this one:

```bash
cd ~/Image-Genarator
pm2 stop gemini-api gemini-worker
```

Fetch and check out the reviewed rebuild branch/commit (or main after the rebuild PR is merged). Do not force-reset a checkout containing local changes. `npm ci`; `npx playwright install --with-deps chromium`. Keep or replace your protected .env with the settings in `.env.example`. Old Atlas/Groq variables are ignored, but should be removed from the new .env after preserving any needed credentials securely. This app doesn't modify Atlas.

Set `PORT=3030`, `DATA_DIR=./runtime`, and choose PUBLIC_ORIGIN to match the address actually used in your browser. Paths relative to your project directory must remain stable across PM2 updates.

## Secure public IP access using existing Caddy

For this VPS, set:

```dotenv
PORT=3030
PUBLIC_ORIGIN=https://162.35.181.135:3443
DATA_DIR=./runtime
```

Your existing Caddy configuration can remain:

```caddyfile
{
    auto_https disable_redirects
}
162.35.181.135:3443 {
    tls internal
    reverse_proxy 127.0.0.1:3030 {
        flush_interval -1
    }
}
```

Caddy supports the viewer's WebSocket upgrade. Node trusts forwarded transport/IP headers only from the loopback proxy. Do not place untrusted proxies directly on loopback or change the binding to a public interface. For multiple proxies, review the trust boundary first. The app checks the Host, Origin and encrypted transport; HTTPS sessions get Secure cookies.

A private CA certificate does not automatically become trusted on your PC. Copy only `/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt` over authenticated SSH, verify its fingerprint and trust that public root on your device. Never copy the CA private key. Alternatively use a domain and a publicly trusted certificate. Keep TLS verification enabled. Only open 3443/tcp (and your SSH port) in both provider firewall and UFW; do not open 3030 or any browser/VNC/debugging port.

Run `sudo caddy validate --config /etc/caddy/Caddyfile`, restart Caddy, and verify it is active. Then `npm run setup-admin` and `node app.js` as dev. Log into the viewer and test a public website. Stop the foreground app with Ctrl+C before starting PM2.

## PM2 and startup

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup`. Once the replacement is working, optionally remove the stopped old entries with `pm2 delete gemini-api gemini-worker` and `pm2 save`. Keep one `vps-browser` instance. Never start two processes against one persistent profile. No worker or Mongo service is needed.

Updates: with no active transfer, `pm2 stop vps-browser`, back up runtime and .env privately, fetch/check out the reviewed commit, `npm ci`, `npx playwright install --with-deps chromium`, `pm2 restart ecosystem.config.cjs --update-env`, `pm2 save`. Recheck login/browser, WebSocket and a small download. PM2's max-memory restart is a recovery guard, not a guaranteed resource quota for Chromium children. Use host disk/memory quotas for hard limits. Allow at least 2 GB RAM for modest browsing and monitor actual resource use. Large websites and many tabs consume substantially more.

## Backup and restore

Stop `vps-browser` before backing up. Archive `.env` and the entire runtime directory with mode 600 to private storage outside the web root. Browser profiles contain live website sessions; encrypt backups and restrict access. Restore only with the service stopped, owned by the service user; directories mode 700 and files private. Restore a compatible reviewed application and browser version, then restart. Some websites may require fresh authentication. Backups and restoration have not been validated on the user's VPS.

## Troubleshooting

- **Invalid credentials:** this is the new local-file admin, not the former Atlas identity. Run `npm run reset-admin` in the project directory using the same DATA_DIR as PM2. If no admin exists, use setup-admin. Usernames/passwords are case-sensitive.
- **Login rate limited:** wait 15 minutes. A forgotten password can be reset using the CLI; restarting clears in-memory sessions and rate counters.
- **Unexpected host / HTTPS required:** correct PUBLIC_ORIGIN and Caddy's forwarded protocol. Keep the original host header through the proxy.
- **502:** check `pm2 logs vps-browser --lines 50`, `pm2 status`, `ss -ltnp` and the proxy's port. Do not share credentials or page content in logs/screenshots.
- **Browser cannot start:** first run `npm run doctor` from this directory as the same PM2 service user. This checks an isolated profile without visiting websites or exposing .env values. The viewer now shows a classified startup reason. install Chromium and system dependencies as the service user; verify non-root execution and sandbox/user-namespace support. Do not add `--no-sandbox` to production. Ubuntu 26.04 dependency compatibility must be tested on the target VPS. Ubuntu 24.04 LTS is a conservative deployment target.
- **Viewer reconnecting:** verify Caddy WebSocket support, session expiry and browser network connection; the viewer reconnects without starting a second Chromium profile.
- **Website fails / private host:** private, local and cloud-metadata network destinations are intentionally blocked. This viewer is for public web browsing.
- **Website refuses login:** stop and follow the site's supported security flow. Remote browsers aren't guaranteed to be accepted.
- **Transfer failure:** check permissions and disk space; uploads are limited to 20 MB, saved downloads to 100 MB and 100 files. Chromium may use temporary disk space before a completed download is inspected; apply OS disk quotas for hard limits.

## Inspecting failures

After deploying this update and restarting vps-browser, refresh the viewer and open Debug console. Reproduce the action once, filter Errors and match the displayed action ID. Export logs if needed; they include safe cause codes and exclude typed text/URLs. Terminal alternative: pm2 logs vps-browser --lines 100. Browser startup errors still need npm run doctor if the cause is not known. The previously reported AppArmor failure is a target VPS configuration issue; diagnostics do not disable sandboxing. Google searches use the VPS network and may fail or be restricted; live Google availability is not claimed.
