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

## AI Agent and promotion drafts

Sign in as a business owner and open **Menu → AI Agent** (`/ai-agent.html`).
The page loads your saved business name/logo and your own product catalog.
Add a product with a name, description and PNG/JPEG/WebP image (up to 3 MB;
the browser compresses it for storage). Products are paginated, 20 per page.
Remove asks for confirmation and preserves already saved draft snapshots.

Click **Promote** on a business logo or product image to open an editable
promotion composer. It uses the selected reference and your business details.
**Save promotion draft** creates a draft for review on Dashboard. Only one
pending draft is allowed by the existing review flow. This feature does not
call an AI model, generate an image, or publish to a social network.

### Catalog API (authenticated owner session cookie required)

| Method | Endpoint                          | Request / response                                                                                       |
| ------ | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| GET    | `/api/products?limit=20&offset=0` | `{products, total, limit, offset}`; limit 1–100                                                          |
| POST   | `/api/products`                   | `{name, description, image}` → 201 `{product}`; image is a raster base64 data URL, max 400000 characters |
| DELETE | `/api/products/:id`               | Removes your own product; another owner's ID returns 404                                                 |
| POST   | `/api/posts/draft`                | `{targetType:"business", text}` or `{targetType:"product", productId, text}` → 201 `{post}`              |

Product names are required (max 80 characters); descriptions max 500;
promotion text 1–800 characters. Draft responses include `targetType`,
`targetName`, `product` and the selected `image` snapshot. Existing generic
`POST /api/posts/draft` requests remain supported.

### Tests

Install root and backend dependencies. With a disposable MongoDB available:

```sh
TEST_MONGODB_URI=mongodb://127.0.0.1:27017 TEST_CHROME=/usr/bin/google-chrome npm test --prefix 'Marketing Agent/backend'
```

The suite creates and drops only a randomly named test database. It covers
image validation, owner isolation, pagination, product removal, draft snapshots,
and desktop/mobile composer flows. Without `TEST_MONGODB_URI`, database and
browser integration checks are explicitly skipped.
