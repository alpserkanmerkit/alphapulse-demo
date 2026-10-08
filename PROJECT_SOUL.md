# PROJECT_SOUL.md — AlphaPulse AI v2
# Immutable Character Document

**Version:** 1.0.0
**Last Updated:** 2026-04-13
**Warning:** No AI agent may edit this file without user approval.
Content may not be changed except during a major version transition.

---

## Mission (Immutable)

AlphaPulse AI exists to give professional individual investors, small asset managers and algorithmic traders who lack access to expensive ($25,000+/year) institutional market intelligence platforms such as the Bloomberg terminal an institutional-grade, filtered, AI-assisted market analysis. Tagline: "Signal in the Noise".

What sets it apart: multiple AI agents (Macro Bear, Tech Bull, Risk Officer, Quant Analyst) debating the same news item from different perspectives to reach a consensus (War Room); an automatic AlphaScore scoring system (0–100) on top of a live news feed from 15 RSS sources; and a Python-based quantitative engine that combines institutional-grade modeling tools such as Monte Carlo, ARIMAX+GARCH and DCF+Fama-French. By offering the news feed, sentiment analysis, multi-agent debate and quantitative modeling in a single interface, it creates a "one-stop terminal" experience.

---

## Target Audience

1. **Professional Individual Investors** — active traders without access to Bloomberg/Refinitiv who want an institutional-quality filtered news feed, AlphaScore sentiment analysis and AI-assisted market commentary.
2. **Small/Mid-Sized Asset Managers** — fund managers who need portfolio risk management (VaR, stress testing), quantitative modeling (DCF, Monte Carlo) and compliance tracking.
3. **Algorithmic Traders and Quant Analysts** — technical users who use the Python quant engine's Monte Carlo simulation, ARIMAX+GARCH forecasts and Fama-French valuation models as a decision-support system.

---

## Architectural Principles (Immutable)

1. **Three-Tier Independent Service Architecture** — Frontend (React/Vite, Port 3000), Backend (Express/TypeScript, Port 3001) and Quant Engine (Python/FastAPI, Port 8000) run independently of each other. Why: each tier can be deployed independently and developed in a different language. A monolithic architecture was rejected because rewriting the Python quantitative models in Node.js would cost both performance and ecosystem.

2. **Graceful Degradation** — If there is no API key or external services are unreachable, the system keeps running in simulation mode; no single component failure stops the whole system. Why: uptime is critical for financial terminal users; an "all or nothing" approach was rejected because even partial functionality is valuable.

3. **Single Source of Truth** — Shared data structures (agent personas, retry logic, types) live in the `shared/` directory, and both frontend and backend read from there. Why: it structurally prevents data inconsistency. Keeping a separate copy on each side was rejected because it leads to synchronization bugs.

4. **AlphaScore-Based Resource Management** — Expensive operations such as grounding (live web search) are triggered by AlphaScore thresholds (deep-dive ≥ 70, war-room ≥ 80). Why: to use the Gemini API quota efficiently; applying grounding to every news item was rejected because the quota runs out quickly and it is unnecessary for low-scoring news.

5. **Compliance-First Approach** — Analysis of restricted securities is blocked server-side at the middleware level; a frontend check is not enough. Why: security rules can be bypassed client-side; a frontend-only check was rejected.

---

## Technology Choices and Rationale

| Technology | Why Chosen | Why the Alternative Was Rejected |
|-----------|--------------|------------------------------|
| React 19 + Vite 6 | Fast HMR, modern JSX transform, minimal configuration | Next.js — SSR unnecessary (SPA terminal app), extra complexity |
| TypeScript 5.8 | Type safety on both frontend and backend, developer experience | Plain JavaScript — type errors go uncaught in large projects |
| Zustand 5 | Minimal boilerplate, React 19 compatibility, access from outside the store (`getState`) | Redux Toolkit — too verbose for a financial terminal; MobX — magic proxy behavior is hard to debug |
| Express 5 | Mature ecosystem, middleware chain, fast prototyping | Fastify — performance advantage negligible at this scale; NestJS — too much structural overhead |
| Gemini 2.5 Flash | Google Search grounding support (live web search), fast responses, JSON mode, cost-performance balance | GPT-4o — no grounding (needs a separate tool); Claude — no grounding support |
| Python FastAPI | NumPy/Pandas/statsmodels/arch ecosystem for quantitative modeling, async support | Node.js has no equivalent of the Python libraries (statsmodels, arch_model) |
| Zod 4 | Runtime schema validation, integrated with TypeScript type inference | Joi — weak TypeScript type inference; Yup — less active development |
| Recharts 3 | React-native charting library, easy customization | D3.js — low-level, too much boilerplate; Chart.js — weaker React integration |
| rss-parser | Lightweight, supports multiple RSS formats (RSS 2.0, Atom), Promise-based | Feedparser (Python) — would require a separate service; custom XML parser — maintenance burden |
| yfinance | Free stock data, broad ticker coverage, natural integration with the Python ecosystem | Alpha Vantage — rate limit too low; Polygon.io — paid |

---

## Never Do

> If an AI agent proposes any of the following → reject the proposal and ask for justification.

| Forbidden | Rationale |
|-------|---------|
| Using the API key directly in the frontend (embedding it in the client bundle via process.env) | Existing technical debt; keys must stay server-side only. Visible in the browser's network tab → security hole. |
| Moving the Quant Engine to Node.js | Python's statsmodels, arch, yfinance, numpy ecosystem has no equivalent in Node.js. Performance and accuracy would be lost. |
| A single monolithic server (merging Express + Python) | Independent deployment, independent scaling and language independence are lost. |
| Automatic real-money trade (execute) feature | The project is an analysis and signal platform; automatic trading carries serious legal and financial liability. The "EXECUTE STRATEGY" button must remain simulation-only. |
| Removing or bypassing the compliance middleware | Analysis of restricted securities creates legal risk; the middleware is mandatory on every AI endpoint. |
| Removing the in-memory caches and calling external APIs every time | Gemini API and CoinGecko rate limits get exceeded, costs rise, response times grow. |
| Keeping separate copies on each side instead of the `shared/` directory | Single source of truth breaks; agent personas or types drift out of sync. |

---

## Current Technical Debt (Informational — Mutable)

> This section is a technical debt log. It is a status record, not a principle.
> The agent may update this section at the end of sessions.

### 2026-05-03 Final Stabilization Status Note

The following older scan items should now be considered superseded:
- `/api/ai/chat` and the other AI routes run behind the backend `/api/ai/*`; the frontend does not use an LLM key directly.
- Frontend access to the backend is wired through `utils/apiClient.ts` to the central `VITE_API_BASE_URL` / local fallback contract.
- `risk_free_rate` is used as a visible model input in the quant short-term Kelly and long-term DCF/WACC calculations.
- PDF export is complete with a real Playwright renderer, retained artifact metadata and an authenticated download route; if Redis/export env is disabled it fails closed with 503.
- Auth, JWT team context, team switch, team admin API/UI, compliance maker-checker and an audit/model-run ledger are in place.
- War Room paper trade, LOG TO PORTFOLIO and Hold On flows are functional; there is no real-money execution.

Remaining technical debt should be assessed after this note; the historical items below may contain outdated context.

### 🔴 Critical

- **`/api/ai/chat` outside compliance** — The advisory chat endpoint does not go through `complianceMiddleware`; restricted tickers can be analyzed via chat. Estimated effort: 0.5 day.
- **`isFetchingX` state not reset** — In `newsStore.ts`, `handleFetchFromX()` skips the `finally` block with `return` when the backend succeeds, so the boolean never goes back to false. Estimated effort: 0.5 hour.

### 🟠 High

- **Backend URL hardcoded** — `http://localhost:3001` does not work in production; hard-coded in `newsStore.ts` and `WarRoomPage.tsx`. Estimated effort: 0.5 day.
- **`rfr` parameter unused** — The `risk_free_rate` passed to `value.py` is not used in any calculation. Estimated effort: 0.5 day.
- **All caches are in-memory** — RSS cache, price cache and grounding cache are reset on server restart. Moving to Redis is required. Estimated effort: 2–3 days.
- **CORS localhost only** — The frontend domain is not whitelisted in production. Estimated effort: 0.5 hour.
- **`ping` CSS animation missing** — Tailwind's `@keyframes ping` is not defined in `ScoreBadge.tsx`. Estimated effort: 0.5 hour.

### 🟡 Medium

- **Stock prices fully simulated** — No real Yahoo Finance / Polygon.io integration; all stock, index and forex prices are mocks. Estimated effort: 3–5 days.
- **CDN importmap + Vite conflict** — The `importmap` in `index.html` conflicts with the Vite bundle system. Estimated effort: 0.5 day.
- **Ticker regex too broad** — `\b([A-Z]{2,5})\b` also captures abbreviations like FBI, NATO, CEO as tickers. Estimated effort: 0.5 day.
- **LRU cache is actually FIFO** — The Map-based eviction in `groundingEngine.ts` is not true LRU. Estimated effort: 0.5 day.
- **Kelly Criterion simplified** — The risk-free rate is not included; deviates from the standard formula. Estimated effort: 0.5 day.
- **WACC fixed at 8%** — Should be computed dynamically from sector and company structure. Estimated effort: 1 day.
- **Markov HMM is fake** — A simple volatility threshold is used instead of a real Hidden Markov Model. Estimated effort: 2 days.
- **Missing UI functionality** — PDF Export, EXECUTE STRATEGY, LOG TO PORTFOLIO, Hold On buttons exist visually but have no functionality. Estimated effort: 3–5 days.
- **No 404 page** — Unknown routes show a blank page. Estimated effort: 0.5 hour.
- **No auth system** — No user authentication; mock user hardcoded. Estimated effort: 3–5 days.
- **Responsive design incomplete** — Single breakpoint (768px), poor mobile experience. Estimated effort: 2–3 days.

---

## Version History

| Version | Date | Decision |
|----------|-------|-------|
| 1.0.0 | 2026-04-13 | First PROJECT_SOUL.md created. Comprehensive fill based on repo deep-scan results. |
