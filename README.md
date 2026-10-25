# Gemini Automation Platform

A private Node.js 22+ / Express / MongoDB application with a vanilla HTML/CSS/JS dashboard and a dedicated Playwright worker. Queue one Gemini web UI image job at a time, reuse isolated Google account profiles, upload reference images and save one original download plus actual image metadata JSON.

**Implementation candidate, not live-validated.** Real Google login, Gemini image generation, Groq and target VPS installation are **UNVERIFIED**. Gemini can return text or refuse to generate; no output is promised. Browser automation can be constrained by Google's terms, security checks and interface changes.

```bash
npm ci
npx playwright install --with-deps chromium
cp .env.example .env
# Configure Mongo URI, random SESSION_SECRET, trusted HTTPS origin and TLS/proxy.
npm run setup-admin
npm run lint
npm test
npm start
# Separate terminal / production PM2 process:
npm run worker
```

Use the [Ubuntu/PM2 deployment runbook](docs/deployment.md) for exact encrypted SSH tunnel access, trusted TLS, administrator provision and interactive Google login. Node and Mongo must be installed. No Redis or Docker. Both services bind/use one VPS and a shared protected runtime directory. Never expose port 3000, a login viewer, browser debugging or admin credentials on public plaintext HTTP.

- [Architecture and consistency limits](docs/architecture.md)
- [API contract](docs/api.md)
- [Security model](docs/security.md)
- [Operations, retention, backup and restore](docs/operations.md)
- [Test evidence and live acceptance checklist](docs/test-report.md)
- [Milestone progress / continuation](docs/progress.md)

Google passwords are entered only into Google's page in the temporary authenticated browser stream. Groq secrets live only in the server environment. Runtime profiles, images, dumps, logs and .env are git-ignored. Admin credentials must be set in an SSH terminal, never chat. Feature PRs require review and authorized merge; no release tag is created automatically.
