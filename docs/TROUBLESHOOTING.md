# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Server exits: `API_KEY is not set but HOST is …` | Non-loopback `HOST` without a key | Set `API_KEY` (≥ 16 chars, e.g. `node -e "console.log(crypto.randomUUID())"`), or `HOST=127.0.0.1` for local-only use |
| Server exits: `API_KEY must be at least 16 characters` | Key too short | Generate a longer one (see above) |
| Rate limit hits every user at once behind nginx/Traefik | All requests share the proxy's IP | `TRUST_PROXY=true` (only behind a proxy you control) |
| `503 ai_not_configured` | No `ANTHROPIC_API_KEY` | Set it, or call with `?score=false&outreach=false` |
| `502 ai_auth_failed` | Invalid Claude key | Replace the key |
| Leads `failed` with "rate limit" | Claude 429 after SDK retries | Lower `AI_CONCURRENCY`, retry with `POST /api/leads/:id/rescore` |
| `502 ai_bad_request` mentioning `fallbacks` | Model/account lacks server-side fallbacks | `CLAUDE_FALLBACKS=off` |
| `emailDomainAcceptsMail: null` + `dns-mx: ECONNREFUSED/ETIMEOUT` | DNS blocked or unreachable from the host (common in sandboxes/firewalls) | Allow outbound DNS (UDP/TCP 53); the agent deliberately reports "unknown" instead of guessing |
| `hunter company: Hunter … HTTP 401` | Invalid `HUNTER_API_KEY` | Check the key at hunter.io |
| `hunter …: timed out after 15000ms` | Hunter slow/unreachable (retried twice) | Lead is still scored without Hunter data; check connectivity |
| `… HTTP 429` persists | Hunter quota exhausted | Raise `HUNTER_MIN_GAP_MS`, upgrade plan, or unset the key |
| Lead marked `duplicate` unexpectedly | Same email, same company domain + full name, or (for leads with no name and no email) same website domain, already stored | Check `duplicateOf`; delete `data/leads.db` to reset a test database |
| `Invalid ICP file` on start | JSON syntax or schema error in `config/icp.json` | Compare with `config/icp.example.json` |
| No outreach drafts | Scores below `OUTREACH_MIN_SCORE` | Lower the threshold or refine the ICP |
| CSV cells start with `'` | Formula-injection protection for values starting with `= + - @` | Expected; remove the quote in the sheet if you trust the data |
| n8n Sheets node: "Sheet not found" | Tab names differ | Create tabs **Leads In** and **Scored Leads** or edit the nodes |
| n8n webhook returns `401`/`403` | Webhook uses Header Auth | Create the **Lead Agent webhook auth** Header Auth credential and send that header |
| n8n webhook returns `502 lead_agent_unavailable` | Lead Agent unreachable/failing after 3 tries | Check `LEAD_AGENT_URL`, `LEAD_AGENT_API_KEY` and the agent logs |
| n8n `$env` denied | Env access blocked | `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` |
