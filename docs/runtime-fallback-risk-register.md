# Runtime Fallback Risk Register

Created: 2026-05-07 Europe/Istanbul

This register tracks runtime fallback states that are technically labeled in the UI but still need periodic verification. It replaces the temporary root note `DELETE_AFTER_REVIEW_runtime_fallback_risks.md`.

## Runtime Health Verification

Use this sequence when validating the local stack:

```bash
npm run dev:stack
npm run health:runtime
```

`npm run health:runtime` does not start services. It verifies that the frontend, backend, compliance summary, readiness endpoint, and quant engine are already reachable. A failure usually means the local stack is not ready, not that the deterministic unit or smoke test suite failed.

## Feed Fallback

Observed state after rollback: `Feed: Fallback Feed`.

Known context:

- This is separate from AI simulation mode.
- This is separate from team context resolution failures.
- It likely means the news/feed layer is using cached, bundled, or fallback data instead of fully live upstream feed data.
- User risk: feed cards may be interpreted as fully live if users miss the fallback badge.

Verification criteria:

- Backend `/health` reports AI, quant, and compliance states.
- `/api/news/feed` response provenance and data-quality fields clearly distinguish live, fallback, degraded, and simulation sources.
- Dashboard or sidebar runtime labels match the backend feed mode.

Close this item when the feed fallback root cause is documented or fixed, and the user-facing label accurately reflects the source state.

## War Room Quant Fallback

Observed War Room badges:

- `UNGROUNDED`
- `QUANT FALLBACK`
- target price `FALLBACK`
- chart badge `QUANT FALLBACK`

Known context:

- `UNGROUNDED` means the debate did not use live grounding.
- `QUANT FALLBACK` means the projection path came from fallback logic instead of a live quant engine/model response.
- `FALLBACK` next to target price means the target should not be treated as fully model-backed live quant output.
- The UI labels the fallback state, but users may still over-trust the recommendation if explanation is too compact.

Verification criteria:

- Quant health is reachable through `npm run health:runtime`.
- War Room request payload includes the expected ticker and horizon.
- Express quant proxy and FastAPI quant engine agree on request/response shape.
- Agent-level fallback quant data does not override a fresher live route preview.

Close this item when the `QUANT FALLBACK` root cause is documented or fixed, and any remaining expected fallback behavior is clear in the UI.

## External-Live Coverage

These checks require configured local secrets or infrastructure and should never record secret values:

- `GEMINI_API_KEY` present for live AI and grounding.
- `JWT_SECRET` present outside local development.
- `QUANT_ENGINE_URL` points to the active quant engine when not using the default.
- `REDIS_URL` and `PDF_EXPORT_ENABLED=true` present before PDF export queue verification.
- `DATABASE_URL` points to the intended local or production-compatible database.

Close this item only after live providers, quant, export, and production readiness have been validated in an environment where secrets are provided through environment variables or approved OAuth/plugin flows.

## Accepted Scan Noise

- `server/shared/auth/jwt.ts` contains a development-only fallback JWT secret. Production startup still requires `JWT_SECRET`; treat this as a known secret-scan false positive unless that production guard changes.
- Vitest may emit a non-failing missing sourcemap warning from `node-cron`. Validation status should be determined by command exit code and test counts.
