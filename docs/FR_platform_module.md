# Functional Requirements — Platform Module (Plugins, Settings & Actions)
**Dhoomberg Terminal | FMCG & Supply Chain Intelligence**
*Version 0.2 — October 2026 · Status: implemented*

---

## Overview

The Platform Module turns Dhoomberg from a fixed dashboard into an extensible, action-driven terminal. Anyone can plug in:

- any data source
- any news source
- any model behind an API
- any algorithm, written in Python or built with no code

Rules built on those inputs can notify people, write to other systems, or place broker orders, including live ones, behind a risk guard.

Everything that touches secrets, third-party APIs, user code or money runs in a **local server** (`server/`, Node 22 + Fastify, bound to 127.0.0.1). The browser is a client of that server. Without the server the terminal falls back to demo mode, exactly as before.

```
browser ──/api──▶ server: vault · registry · connectors · rules engine · order guard · audit · SQLite
                              └─ stdio JSON-RPC ─▶ Python worker ─▶ plugins/*.py
```

**Run:** `npm start` (terminal on :5173 + server on :8787) · `pip install -r requirements.txt` for Python plugins.

---

## Feature List

### F-PLAT-001 — Local server and security model
**Behaviour**
- Binds to `127.0.0.1` only; it is not reachable from the LAN.
- Every `/api` request must carry the per-install token, either as an `X-Dhoomberg-Token` header or as a `SameSite=Strict` cookie.
  - In dev, the Vite proxy adds the header, so the browser never holds the token.
  - In production (`npm run serve`), the server serves the built UI and sets the cookie.
- The Host header must be localhost, which blocks DNS rebinding.
- Any Origin header must be a terminal origin. Other websites get 403, even through the proxy.
- POST requests must be `application/json`, which blocks cross-site form posts. PUT and DELETE always require a CORS preflight, which foreign origins fail.

**Acceptance**
- No token → 401.
- Foreign Origin → 403.
- Non-local Host → 403.
- Form POST → 415.
- LAN IP unreachable.
- All verified in `tests/server.test.ts` and by manual probe.

### F-PLAT-002 — Secret vault
**Behaviour**
- Plugin schema fields marked `x-secret` are encrypted with AES-256-GCM, using the record ID as additional authenticated data.
- The key comes from `DHOOMBERG_MASTER_KEY` (64 hex characters) or from `.dhoomberg/master.key`, created on first run.
- The API only ever returns a mask (`●●●●1a2b`).
- Sending the mask back keeps the stored value.
- Config export never includes secrets.

**Acceptance**
- Plaintext is not present in the database.
- Tampering with the stored data is detected.
- No API response in the test run contains a stored secret; the test scans every response body.

### F-PLAT-003 — Plugin registry and schema-driven settings
**Behaviour**
- Every connector is a manifest with:
  - `kind`: datasource, news, model, action or broker
  - a JSON-Schema config
  - capabilities: `realtime`, `llm`, `forecast`, `live`
  - an implementation with `test()`
- The Settings UI renders any plugin's form from its schema (`SchemaForm`). Adding an API means adding a manifest; no UI work is needed.
- A plugin can have many configured *connections*, for example two OpenAI-compatible endpoints.
- Every connection has a Test button. The last result is stored and shown in the status bar.

### F-PLAT-004 — Data sources
**Generic adapters**
- **REST/JSON/CSV/NDJSON**:
  - URL template with `{symbol} {from} {to} {apiKey}`
  - auth: none, query, header, bearer, basic, or OAuth2 client credentials
  - path mapping for rows, date and OHLCV; handles row arrays, objects keyed by date, columnar arrays, and arrays of arrays
  - fixed-point scale
  - optional real-time quote endpoint
- **CSV**: upload a file or point to a URL. Each column is an instrument.
- **WebSocket**: subscribe template plus price, symbol and time paths.

**Presets**

| Group | Presets |
|---|---|
| Macro | FRED, EIA, USDA QuickStats |
| Market data | Alpha Vantage (commodities and equities), Twelve Data, Polygon, Nasdaq Data Link, Tiingo, Yahoo (unofficial), Barchart, Databento |
| Crypto | Binance, Coinbase |
| Broker data | OANDA pricing, IBKR market data |
| Python | `@datasource` plugins |

**Instruments**
- Any symbol from any source can be added as an instrument, with ID, name, unit, decimals, contract multiplier, source and symbol.
- Built-in commodities can be re-pointed to a real feed (`SOURCE BRENT YAHOO:BZ=F`).

**Acceptance**
- Verified live against Yahoo (CL=F), Binance and Coinbase.
- Parsers are unit-tested against Alpha Vantage, FRED, Yahoo, Binance and Databento response shapes.

### F-PLAT-005 — News sources
**Sources**
- Any RSS or Atom feed.
- A generic JSON news API with field mapping.
- Presets: Alpha Vantage News & Sentiment, NewsAPI, GDELT, Finnhub, Polygon, Benzinga, Marketaux, plus RSS feeds from CNBC, USDA and EIA.

**Processing**
- Items from all enabled sources are merged, deduplicated and tagged to commodities on word boundaries.
- Provider sentiment is used when available. Otherwise a headline lexicon scores the item, and the item is labelled `lexicon-sentiment`.
- The Wire panel has a source selector and shows sources that are failing.

### F-PLAT-006 — Indicators (built-in + Python)

| Pane | Indicators |
|---|---|
| Overlay | SMA, EMA, WMA, Bollinger, Donchian, Keltner (close-based ATR proxy), regression channel |
| Sub-pane | RSI, MACD, ROC, z-score, realised vol, percentile rank, rolling correlation vs another instrument, price ratio vs another instrument |

- Python indicators and signals come from `@indicator` / `@signal` in `plugins/*.py`.

**Chart**
- The `IND ▾` dropdown adds an indicator; chips edit its parameters.
- Sub-panes are synced by date.
- Commands: `IND ADD <name> [params]`, `IND REMOVE`, `IND CLEAR`.

**Acceptance**
- SMA, EMA, WMA, Bollinger, RSI and ROC match TA-Lib to 1e-9.
- MACD matches TA-Lib after convergence.
- Test file: `tests/indicators.test.ts`.

### F-PLAT-007 — Models
**Built-in:** naive, seasonal naive, drift, linear trend, Holt damped, and Holt-Winters. These run in the browser and on the server.

**Python:** `@model` plugins.

**Custom HTTP models:** we POST the price series, and the endpoint returns the next N values.

**LLM providers**
- Anthropic.
- OpenAI-compatible endpoints: OpenAI, Gemini, Mistral, Groq, Together, OpenRouter, Hugging Face, Ollama, LM Studio, and any other.
- Replicate.

**Rigor rule:** every forecast is shown next to the naive baseline. Each forecast gets a rolling-origin out-of-sample evaluation, and the chart shows *OOS skill vs naive*. Bands are empirical quantiles of the out-of-sample errors.

**LLM analyst**
- The analyst receives price stats, RSI, Bollinger bands and the tagged headlines.
- It must return JSON: `{bias, confidence, rationale}`, which is validated.
- The view is cached for 30 minutes and can be used in rules as a bias score in [−1, 1].

### F-PLAT-008 — Python plugin runtime
**SDK and loading**
- The `dhoomberg_runtime` SDK provides four decorators: `@indicator`, `@signal`, `@model` and `@datasource`.
- One long-lived worker runs the plugins and talks to the server over NDJSON on stdio.
- Plugin `print` output is redirected so it cannot corrupt the protocol.
- NaN values are returned as null.

**Robustness**
- Each call has a timeout. A hung or crashed worker is killed and restarted with backoff.
- Plugins reload automatically when a file changes.
- A file with a syntax error is reported in Settings without breaking the other plugins.

**Examples:** Kalman trend, GARCH(1,1) volatility, Theta model, N-bar breakout signal, and a warehouse CSV data source.

**Acceptance:** `tests/pybridge.test.ts`, which covers discovery, all four kinds, exceptions, timeout recovery and crash recovery.

### F-PLAT-009 — No-code signal builder and rules engine
**Conditions**
- Operands:
  - price
  - indicator (built-in or Python, any output)
  - model forecast % change
  - news sentiment, or bullish/bearish counts
  - LLM bias
  - demand series
  - COT net long %
  - a constant
- Operators: `> < ≥ ≤`, crosses above / below, % change over N bars greater / less than, between.
- Conditions combine in nested ALL/ANY groups.

**Rule settings**
- Cadence: every engine tick (15 s), every N minutes, or once per new bar.
- Cooldown.
- Optional active hours.

**How rules fire**
- A rule fires when its condition *becomes* true (edge-triggered).
- Crosses on point-in-time operands use the previous live evaluation.
- Missing data is never treated as true.

**Evaluate now** shows each condition's live values.

**Backtest**
- Shows fire markers on the chart.
- Reports the directional forward return against the unconditional baseline, plus hit rate.
- Splits results into first half and second half as a stability check.
- Includes an explicit in-sample / selection-bias warning.
- Lists any conditions that cannot be backtested, and whether skipping them inflates or deflates the fire count.

**Chart integration:** `SIGNAL ▾` and `BACKTEST <rule>` plot a rule's historical fires.

### F-PLAT-010 — Actions and integrations

| Category | Integrations |
|---|---|
| Messaging | Slack, Teams (Workflows), Discord, Telegram, email (SMTP), SMS (Twilio) |
| Generic | Webhook with HMAC signing; covers Zapier, Make, n8n and Power Automate |
| Spreadsheets & databases | Google Sheets (service account), Excel via Microsoft Graph, Notion, Airtable |
| ERP | SAP S/4HANA OData (with the CSRF handshake), Oracle NetSuite REST (OAuth 1.0a TBA, HMAC-SHA256) |
| Incidents & tickets | PagerDuty, Jira |

**Templates:** JSON body templates escape string placeholders, and `{{data}}` embeds the full event object.

### F-PLAT-011 — Brokers and execution modes
**Brokers:** Paper (built-in ledger), Alpaca, OANDA, Tradovate, Interactive Brokers (Client Portal Gateway).

**Setup**
- Every broker defaults to its paper or demo environment.
- Each broker has trading-hours and "allow auto" settings.

**Execution modes per rule**

| Mode | What happens to orders |
|---|---|
| notify | Orders are only *suggested* in the message |
| confirm | An approval card appears in the Blotter (`APPROVE <id>`); approvals expire |
| auto | Orders are placed only if the broker allows auto; otherwise the order is downgraded to confirm, and the downgrade is audited |

**Manual orders:** the Blotter ticket, or `BUY|SELL <qty> <ID> [LMT p] [ON broker]`.

### F-PLAT-012 — Order guard (pre-registered defaults)
Every order goes through one serialised path, so limits cannot race. All failing reasons are reported.

| Check | Default |
|---|---|
| Kill switch (HALT) | Off |
| Max order notional (qty × price × multiplier) | $10,000 |
| Max daily notional | $50,000 |
| Max orders per day | 20 |
| Max position per instrument (only blocks increases) | $25,000 |
| Limit price band from last | 2% |
| Max quote age | 300 s |
| Live requires: armed broker + real-time source | Required |
| Duplicate (rule + bar idempotency key) | Blocked |
| Broker trading hours | Per broker |

**Arming live trading** requires all of:
1. The connection's environment is set to `live`.
2. The user retypes the account ID in Settings.

Demo and delayed sources (Yahoo, Alpha Vantage, World Bank) can never drive live orders.

**HALT**
- Cancels open orders at every broker.
- Rejects pending approvals.
- Blocks all new orders until RESUME.

**Acceptance:** `tests/guard.test.ts` has 26 tests, including a rejection test for every limit and trading-hours cases that cross midnight. End-to-end paper flow and HALT are tested in `tests/server.test.ts`.

### F-PLAT-013 — Audit log
**What is recorded:** every rule fire, notification, approval, expiry, order (submitted, filled, rejected with reasons, error), risk-limit change, arm or disarm, HALT or RESUME, connection change and config import.

**Append-only:** SQLite triggers refuse UPDATE and DELETE.

**Viewing:** filterable in Settings → Audit Log, with CSV export.

### F-PLAT-014 — Workspace and customisation
**Panels**
- Seven panel slots; any panel can go in any slot via the header ▾ or Settings → Workspace.
- New Blotter panel: approvals, positions and P&L per broker (paper and live separated), orders with rejection reasons, and an order ticket.

**Config**
- Config import and export covers connections, instruments, rules, risk limits and layout.
- Secrets are excluded, and imported rules arrive disabled.

**Navigation**
- Deep links run commands on load: `?cmd=COCOA;IND ADD RSI;MODEL HOLT`.
- Command history with ↑/↓.

**Status bar:** LIVE/PAPER badge, HALTED badge, and per-connector health.

### F-PLAT-015 — Command vocabulary (additions)
```
SETTINGS [tab]         CONNECT <plugin>          SOURCE <ID> <conn>:<symbol>
IND ADD|REMOVE|CLEAR   MODEL <model> [bars]|OFF  RULE NEW · RULES · BACKTEST <rule>
BUY|SELL <qty> <ID> [LMT p] [ON broker]          APPROVE|REJECT <id> · APPROVALS
HALT [reason] · RESUME BLOTTER · ORDERS · POSITIONS
ALERT … (now a persistent server rule when the server runs; browser-only alert otherwise)
SET SLACK <url> (stored in the vault, not localStorage)
```

---

## Known limits / open items
- **Broker adapters (Alpaca, OANDA, Tradovate, IBKR)** are built against each vendor's documented API. Their request shapes are covered by the guard and flow tests through the paper broker. They still need a round-trip on each vendor's paper or demo account with real credentials before anyone enables live trading.
- **SAP and NetSuite** templates assume a custom entity set or record type that the customer creates.
- **Excel upload** is CSV-only. Use Save As → CSV.
- **GDELT** rate-limits shared IPs (HTTP 429).
- **The Yahoo endpoint** is unofficial.
- **Python plugins** run with the user's permissions, so only load trusted code.
