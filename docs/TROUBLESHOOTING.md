# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `503 ai_not_configured` | No `ANTHROPIC_API_KEY` | Set it, or call with `?score=false&outreach=false` |
| `502 ai_auth_failed` | Invalid Claude key | Replace the key |
| Leads `failed` with "rate limit" | Claude 429 after SDK retries | Lower `AI_CONCURRENCY`, retry with `POST /api/leads/:id/rescore` |
| `502 ai_bad_request` mentioning `fallbacks` | Model/account lacks server-side fallbacks | `CLAUDE_FALLBACKS=off` |
| `emailDomainAcceptsMail: null` + `dns-mx: ECONNREFUSED/ETIMEOUT` | DNS blocked or unreachable from the host (common in sandboxes/firewalls) | Allow outbound DNS (UDP/TCP 53); the agent deliberately reports "unknown" instead of guessing |
| `hunter company: Hunter … HTTP 401` | Invalid `HUNTER_API_KEY` | Check the key at hunter.io |
| `… HTTP 429` persists | Hunter quota exhausted | Raise `HUNTER_MIN_GAP_MS`, upgrade plan, or unset the key |
| Lead marked `duplicate` unexpectedly | Same email, or same company domain + full name, already stored | Check `duplicateOf`; delete `data/leads.db` to reset a test database |
| `Invalid ICP file` on start | JSON syntax or schema error in `config/icp.json` | Compare with `config/icp.example.json` |
| No outreach drafts | Scores below `OUTREACH_MIN_SCORE` | Lower the threshold or refine the ICP |
| CSV cells start with `'` | Formula-injection protection for values starting with `= + - @` | Expected; remove the quote in the sheet if you trust the data |
| n8n Sheets node: "Sheet not found" | Tab names differ | Create tabs **Leads In** and **Scored Leads** or edit the nodes |
| n8n `$env` denied | Env access blocked | `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` |
