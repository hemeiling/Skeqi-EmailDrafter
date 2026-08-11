# Inbound reply detection — operations notes

The CRM has **no mailbox read access**. Replies reach it only because a
forwarding rule *offers* candidates to one endpoint, and the server decides
what is relevant.

## Configuration

| | |
|---|---|
| Env var | `REPLY_INGEST_TOKEN` — exact name, case-sensitive |
| Read at | `server.js` (`process.env.REPLY_INGEST_TOKEN`), read directly, not via `config.js` |
| Declared in | `render.yaml` with `sync: false` (value set in the Render dashboard) |
| Endpoint | `POST /api/replies/ingest` |
| Header | `x-ingest-token: <token>` (or `Authorization: Bearer <token>`) |

If the variable is unset the endpoint returns **503** and reply detection is
off. It never falls back to an unauthenticated mode.

## What the connector sends

```json
{
  "headers": {
    "Message-ID": "<reply-id@provider>",
    "In-Reply-To": "<our-original-id@…>",
    "References": "<…> <our-original-id@…>",
    "From": "someone@customer.com",
    "Date": "2026-08-11T02:00:00Z"
  },
  "snippet": "short preview, no full body needed"
}
```

`In-Reply-To` **and** every id in `References` are checked, because mail
clients rewrite these inconsistently. A candidate matching none of the
message ids the CRM has sent is discarded on arrival.

## Responses

| Response | Meaning |
|---|---|
| `matched: true` | Recorded; bell count, analytics and threads update |
| `matched: false` | Not a reply to a CRM-sent message — discarded |
| `duplicate: true` | Already recorded; re-delivery, not a stranger |
| `401` | Missing or wrong token |
| `503` | `REPLY_INGEST_TOKEN` not configured |

## Known limitations (by design)

- **Reply body is snippet-only.** The connector is not asked for full bodies,
  so the Email page shows a preview and says the full message is in the
  mailbox. This keeps message content out of the CRM rather than duplicating
  a mail store.
- **Legacy threads may show "(no recipient)".** Communications created before
  contact linking existed have no associated contact. Cosmetic; affects
  historical rows only.

Neither is expanded unless it becomes a user-facing problem.
