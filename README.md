# Gemini Automation Platform
Node.js 22+, Express, MongoDB, vanilla dashboard and isolated Playwright profiles. API and worker are separate processes. Implementation progress and release blockers: [docs/progress.md](docs/progress.md).

Install with `npm ci`. Copy `.env.example` to `.env`, set a random session secret and HTTPS origin. `npm run lint` checks syntax. Never commit credentials or runtime data. Live Google/Gemini integrations remain unverified until target VPS acceptance.
