# AlphaPulse Demo

A small, key-free demo that starts with one command: a financial intelligence terminal (React/Vite UI + Express/Prisma server).
No external services (Gemini, RSS/news, market APIs, Redis); everything runs on sample data. This is **not** real market data.

## Prerequisites

- Node.js 22+
- Internet access is needed only for `npm install`.

## Run

```bash
npm install && npm run demo
```

When ready, this line appears: `[demo] READY  ui: http://127.0.0.1:3000 ...`. Open `http://127.0.0.1:3000` in your browser; press Ctrl+C to stop.

`npm run demo` does the following for you: creates a temporary SQLite database, runs `prisma generate` and the migrations, generates
**a random `JWT_SECRET`** on every run (>= 32 bytes, kept only in process memory), and starts the server and the UI. The repo contains no hard-coded secret.
Ports: `DEMO_API_PORT` (3001), `DEMO_UI_PORT` (3000). Set `DEMO_VERBOSE=1` for server logs.

## What you see on startup

No login form appears; the UI signs in automatically with the public demo account:

| | |
|---|---|
| Email | `demo@example.com` |
| Password | `alphapulse-demo-2026` |

This account is not a real person and is created only in demo mode (the password is hashed with bcrypt on the server). It does not exist in normal mode.

- **Intelligence Feed**: sample news, with a sample AI analysis for each item (score, sentiment, affected assets).
- **Portfolio & Risk**: a sample 5-position portfolio, price history chart, VaR/risk metrics.
- **Strategy Boardroom**: agent debate (War Room) with fixed sample text.
- **Compliance**: the sample compliance dataset shipped in the repo.

## Endpoints that return mock data

| Endpoint | Content |
|---|---|
| `GET /health` | `demo: true`, service statuses |
| `GET /api/news/feed` | 12 sample news items (`provenance.mode = simulation`) |
| `GET /api/news/prices?symbols=AAPL,BTC` | fixed-seed sample prices for 23 symbols (source `DemoData`) |
| `GET /api/news/prices/history?symbols=AAPL&range=3M` | sample daily OHLC history (3M/6M/12M/24M) |
| `POST /api/ai/analyze`, `/deep-dive`, `/agent-analysis`, `/debate`, `/chat` | fixed template text; same input gives the same response, no calls to Gemini |
| `GET /api/portfolio/state`, `/risk` | the demo account's sample portfolio (real SQLite, sample prices) |

Authentication, portfolio, compliance and team endpoints are real code; they only use a temporary local SQLite database.

## Limitations

- The data is fictional; this is not investment advice. News headlines are samples.
- The UI requests its font from Google Fonts; offline it falls back to the system font (the only browser-side external request).
- The quant engine (Python/FastAPI) is not part of the demo; forecast endpoints return a local fallback calculation.
- PDF export is disabled (no Redis); it returns `503`.
- The database lives in a temporary directory and is deleted when the demo stops.
- The server binds only to `127.0.0.1` (because of the public demo account it is not reachable from the network).
- Demo mode is enabled with `DEMO_MODE=1`; if `GEMINI_API_KEY` is not set and `NODE_ENV` is not `production`, `npm run server` also switches to demo mode automatically (disable with `DEMO_MODE=0`).

## Test

```bash
npm run test:unit   # unit tests (demo mode: tests/demo)
npm run test:demo   # starts the demo, runs an API + UI smoke test (Playwright/Chromium), then shuts it down
```

`test:demo` requires Chromium (the path can be set with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`; otherwise `npx playwright install chromium`).
