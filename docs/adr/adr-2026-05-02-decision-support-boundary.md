# ADR: Decision Support Boundary

Date: 2026-05-02
Status: Accepted

## Context

AlphaPulse is an institutional decision-support terminal. It can analyze market data, news, portfolio risk, compliance status, and simulated paper trades. It must not be represented as regulated investment advice or real-money execution infrastructure.

## Decision

AlphaPulse product, API, and audit language must preserve these boundaries:

- The system provides decision support only.
- The system does not guarantee returns or provide regulated investment advice.
- Trade flows are paper/simulation workflows unless a future approved execution integration explicitly changes that boundary.
- Live, delayed, fallback, and simulated outputs must be labeled through provenance and data-quality metadata.

## Consequences

- Compliance and portfolio write paths require explicit authorization and audit-friendly actor context.
- Market, AI, quant, and portfolio outputs must expose provenance and data-quality fields.
- UI and API copy must avoid implying real-money execution when using the built-in portfolio workflow.
