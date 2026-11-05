# Marketing Agent

```
Marketing Agent/
├── frontend/   HTML, CSS, vanilla JS
└── backend/    Node + Express + Mongoose (MongoDB Community, local)
```

## Run
1. Start MongoDB Community locally (default port 27017).
2. In `backend/`:
   ```
   cp .env.example .env      # Windows: copy .env.example .env
   # edit .env and set JWT_SECRET
   npm install
   npm start
   ```
3. Open http://localhost:3000 (Express serves the frontend, so don't open the HTML files directly).

## Database: marketing_agent
- `users`: name, email, phone, role, passwordHash (bcrypt), preferences { tone, language, platforms, postFrequency, brandColor, targetAudience }
- `profiles`: owner (-> users), name, category, city, description, logo

## API
POST /api/auth/signup | /login | /logout, GET /api/auth/me,
PATCH /api/account (name, phone, preferences), GET/PUT /api/profile, GET /api/businesses
