# Architecture

| Module | Responsibility |
|---|---|
| `src/schemas.ts` | Zod schemas for raw leads, ICP, and Claude's structured outputs |
| `src/normalize.ts` | Pure functions: normalization, dedupe keys, rule-based ICP signals |
| `src/enrich.ts` | DNS MX lookup, Hunter.io client with throttle + 429 retry |
| `src/ai.ts` / `src/claude.ts` | Claude scoring and outreach via structured outputs; provenance filter |
| `src/service.ts` | Batch pipeline with bounded concurrency and per-lead error isolation |
| `src/store.ts` | SQLite: `leads` (JSON payload + indexed score/tier), `lead_keys` (dedupe index, unique) and `idempotent_leads` (Idempotency-Key → lead) |
| `src/csv.ts` | RFC 4180 CSV with formula-injection protection |
| `src/app.ts`, `src/http.ts` | Routes, auth, rate limiting, error responses |

## Batch pipeline

```mermaid
sequenceDiagram
  participant Client
  participant Agent
  participant DB as SQLite
  participant DNS
  participant Hunter
  participant Claude
  Client->>Agent: POST /api/leads {leads[1..50]}
  loop each lead (sync, before any await)
    Agent->>Agent: Zod validate + normalize
    Agent->>DB: claim dedupe keys + insert lead (one transaction; key conflict = duplicate)
  end
  par up to AI_CONCURRENCY leads
    Agent->>DNS: MX(email domain)
    Agent->>Hunter: companies/find, email-verifier (throttled)
    Agent->>Claude: score vs ICP (effort low)
    alt score >= OUTREACH_MIN_SCORE
      Agent->>Claude: outreach draft (effort medium)
      Agent->>Agent: drop personalization citing missing fields
    end
    Agent->>DB: save
  end
  Agent-->>Client: results[] + summary
```

## Anti-fabrication measures

1. **Field allow-list** – `leadFacts()` builds the only object Claude sees, omitting empty fields; the lead's email address is never sent to the model.
2. **Provenance** – the outreach schema requires `source_field` (an enum of lead fields) for each personalization; `verifyPersonalization()` removes any that cite a field the lead lacks.
3. **Unknown ≠ false** – DNS timeouts give `emailDomainAcceptsMail: null`; ICP signals are `null` when data is missing; the prompt tells Claude unknowns pull scores toward the middle.
4. **Separate enrichment** – provider data lives under `enrichment` with `sources`, never overwriting user-supplied fields.
5. **Tier consistency** – the tier is re-derived from the clamped numeric score (except an explicit `D` for exclusions).
