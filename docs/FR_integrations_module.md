# Functional Requirements — Integrations Module
**Dhoomberg Terminal | FMCG & Supply Chain Intelligence**
*Version 0.1 — October 2026*

---

## Overview

The Integrations Module connects the Dhoomberg terminal to external systems — both inbound (pulling procurement, contract, BOM, and demand data from ERP and spreadsheet sources) and outbound (pushing alerts and exports to collaboration tools, file formats, and custom endpoints).

Integration types:
- **EXPORT** — push data out of Dhoomberg (CSV/Excel, Google Sheets, webhooks)
- **IMPORT** — pull user data into Dhoomberg (ERP connectors, file templates)
- **ALERT** — event-driven outbound notification (Slack, Teams, generic webhooks)
- **CLI** — command-line interface for scripted and automated workflows

All browser-side integrations store credentials in `localStorage` — no proxy server is involved. A thin backend will be required in production for OAuth callback handling (Google Sheets) and scheduled data fetching; for the current milestone all credential handling is client-side.

---

## Feature List

---

### F-INT-001 — CSV / Excel Export

**Description:** Exports any of the following datasets to a downloadable file: price history, forecast (P10/P50/P90 bands), seasonal decomposition components, leading indicators panel, and demand signals. Pure browser execution — no server call, no API key required.

**Export targets:**
| Dataset | Format | Source Feature |
|---|---|---|
| Price history (spot + contract) | CSV, XLSX | F-PRICE-001, F-PRICE-003 |
| Forecast bands (P10/P50/P90) | CSV, XLSX | F-PRICE-020a |
| Seasonal decomposition (trend, seasonal, residual) | CSV, XLSX | F-PRICE-022 |
| Leading indicators panel | CSV, XLSX | F-PRICE-021 |
| Demand signals | CSV, XLSX | F-DEMAND-012 |

**Implementation:**
- CSV: native `Blob` + `URL.createObjectURL` download trigger
- XLSX: SheetJS (`xlsx` npm package, open-source Apache-2.0 licence)
- No server round-trip; all data already resident in browser state

**Trigger:** `EXPORT` command (F-CMD-003) or Export button in any chart toolbar.

**Data Source:** CALCULATED / USER-SUPPLIED (whatever is currently loaded in the view)

---

### F-INT-002 — Slack Incoming Webhook

**Description:** Sends a structured Slack message block when a monitored event fires. The user pastes their Slack incoming webhook URL (obtained from Slack app settings → Incoming Webhooks). No Slack SDK is required — the terminal POSTs a JSON payload directly to the webhook URL.

**Trigger events:**
| Event | Source Feature |
|---|---|
| Price alert fires (threshold crossed) | F-PRICE-001 alert layer |
| Demand shock alert appears | F-DEMAND module |
| WASDE / EIA report released | F-NEWS / report feed |

**Message format (Slack Block Kit):**
```
Commodity:    <name>
Alert type:   <Price Alert | Demand Shock | Report Release>
Current value: <value>
Threshold:    <configured threshold>
Link:         https://dhoomberg.app/?commodity=<id>
```

**Credential handling:**
- Webhook URL stored in `localStorage` key `dhoomberg.slack.webhookUrl`
- Never transmitted to any third-party server other than the user's own Slack workspace endpoint
- User can clear or update the URL at any time

**Trigger:** `SLACK` command (F-CMD-008) to configure; alerts fire automatically once configured.

**Data Source:** ALERT (event-driven, no additional API)

---

### F-INT-003 — Microsoft Teams Webhook

**Description:** Same pattern as F-INT-002 for Microsoft Teams. The user pastes an incoming webhook URL from Teams channel settings. The terminal sends an Adaptive Card payload.

**Trigger events:** Identical to F-INT-002 (price alert, demand shock, WASDE/EIA report release).

**Message format (Adaptive Card):**
- `TextBlock` rows for: commodity name, alert type, current value, threshold
- `Action.OpenUrl` button linking to the terminal

**Credential handling:**
- Webhook URL stored in `localStorage` key `dhoomberg.teams.webhookUrl`
- No server involvement; direct browser POST to the Teams webhook endpoint

**Trigger:** `SET TEAMS <url>` command in the command bar.

**Data Source:** ALERT (event-driven)

---

### F-INT-004 — Google Sheets Integration

**Description:** Bidirectional integration with Google Sheets via the Google Sheets API, authorised through OAuth 2.0 in the browser (Google Identity Services). Requires the user to supply a GCP project OAuth client ID (public-facing client credential, not a secret). No server-side OAuth handler is required for the demo; a thin backend redirect handler will be needed for production deployment.

**Two flows:**

**F-INT-004a — Export to Google Sheets**
Writes price history and forecast data for a selected commodity to a new sheet tab in a user-chosen spreadsheet.
- Columns: Date, Spot Price, P10 Forecast, P50 Forecast, P90 Forecast, Contract Price
- Tab named: `<CommodityName>_<YYYY-MM-DD>`

**F-INT-004b — Import from Google Sheets**
Reads user-supplied procurement and planning data from named columns in a designated sheet. Column headers must match the Dhoomberg import template (downloadable from F-INT-008).

| Import type | Named columns required | Fed into |
|---|---|---|
| Procurement prices | Supplier, Commodity ID, Price, Volume, Start Date, End Date | F-PRICE-003 |
| Demand plan | SKU, Month, Volume | F-DEMAND-012 |
| Contract data | Supplier, Commodity ID, Price, Volume, Start Date, End Date | F-PRICE-003 |

**Credential handling:**
- OAuth access token stored in `localStorage` key `dhoomberg.gsheets.token`
- GCP OAuth client ID stored in `localStorage` key `dhoomberg.gsheets.clientId`
- Tokens refreshed via Google Identity Services library (silent re-auth)
- No credentials sent to any Dhoomberg server

**Pre-requisites:** GCP project with Google Sheets API enabled; OAuth consent screen configured; browser-origin authorised in GCP credentials.

**Trigger:** `EXPORT SHEETS` command or Import button in the data panel.

**Data Source:** EXPORT → CALCULATED / USER-SUPPLIED; IMPORT → USER-SUPPLIED

---

### F-INT-005 — SAP Integration

**Description:** Pulls procurement, BOM, and contract data from SAP environments. Supports two connection modes selected by the user.

**F-INT-005a — SAP BTP (Business Technology Platform)**
Connects to SAP BTP via REST API to read:
| Data object | SAP transaction / object | Endpoint pattern |
|---|---|---|
| Purchase order prices | MM60 | SAP BTP REST service (tenant-specific URL) |
| BOM data | MARA | SAP BTP REST service |
| Contract list | ME2M | SAP BTP REST service |

- Auth: OAuth client credentials flow (client ID + client secret supplied by user)
- BTP tenant URL supplied by user

**F-INT-005b — SAP S/4HANA Cloud Public API**
Connects to SAP S/4HANA Cloud standard OData v4 public APIs:
| Data object | API endpoint |
|---|---|
| Purchase orders | `/sap/opu/odata/sap/API_PURCHASEORDER_PROCESS_SRV` |
| Product master | `/sap/opu/odata/sap/YY1_PRODUCTMASTER_CDS` |

- Auth: API key (x-api-key header) supplied by user
- Base URL supplied by user (S/4HANA tenant hostname)

**Data fed into:** F-PRICE-003 (contract prices), F-PRICE-007 (BOM structure), F-DEMAND-012 (demand plan)

**Credential handling:**
- All credentials (BTP tenant URL, OAuth client ID/secret, S/4HANA API key) stored in `localStorage` under `dhoomberg.sap.*` keys
- No credentials proxied through any Dhoomberg server

**Trigger:** `SET SAP` command in the command bar; sync runs on demand or on a configurable schedule.

**Data Source:** USER-SUPPLIED (via SAP REST/OData)

---

### F-INT-006 — Oracle / NetSuite Integration

**Description:** Pulls purchase order and item master data from Oracle Cloud SCM and NetSuite. Feeds the same downstream features as F-INT-005.

**F-INT-006a — Oracle Cloud SCM**
| Data object | REST endpoint |
|---|---|
| Purchase orders | `/fscmRestApi/resources/11.13.18.05/purchaseOrders` |

- Auth: Basic auth or OAuth 2.0 (user-supplied credentials)
- Base URL: Oracle Cloud SCM tenant hostname (user-supplied)

**F-INT-006b — NetSuite (SuiteQL)**
Connects to NetSuite via SuiteQL REST API to read purchase orders and item master records.
- Auth: OAuth 1.0 HMAC-SHA256 (Account ID + Consumer Key/Secret + Token/Secret — all user-supplied)
- Account ID stored as subdomain in NetSuite REST endpoint: `https://<accountId>.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`

**Data fed into:** F-PRICE-003 (contract prices), F-PRICE-007 (BOM structure), F-DEMAND-012 (demand plan)

**Credential handling:**
- All credentials stored in `localStorage` under `dhoomberg.oracle.*` and `dhoomberg.netsuite.*` keys
- OAuth 1.0 signing performed client-side in the browser; no server involvement

**Trigger:** `SET ORACLE` / `SET NETSUITE` commands in the command bar.

**Data Source:** USER-SUPPLIED (via Oracle REST / NetSuite SuiteQL)

---

### F-INT-007 — Generic Outbound Webhook

**Description:** User configures one or more outbound webhook endpoints. Any alert event (price alert, demand shock, COT crowded-trade flag) is POSTed as a versioned JSON payload to all configured endpoints. Enables integration with any downstream system: PagerDuty, custom ERP listeners, internal Slack bots, Azure Logic Apps, Zapier, Make.

**Payload schema (`dhoomberg-alert/v1`):**
```json
{
  "schema": "dhoomberg-alert/v1",
  "timestamp": "<ISO 8601>",
  "commodity": "<commodity ID>",
  "commodityName": "<display name>",
  "alertType": "PRICE_ALERT | DEMAND_SHOCK | COT_CROWDED | REPORT_RELEASE",
  "currentValue": <number>,
  "threshold": <number | null>,
  "direction": "ABOVE | BELOW | null",
  "message": "<human-readable summary>",
  "terminalLink": "https://dhoomberg.app/?commodity=<id>"
}
```

**Endpoint configuration:**
| Field | Required | Notes |
|---|---|---|
| URL | Yes | Any HTTPS endpoint |
| Auth header name | No | e.g., `Authorization` |
| Auth header value | No | e.g., `Bearer <token>` — stored in `localStorage`, never logged |
| Label | No | User-defined name for the endpoint |

**Behaviour:**
- Multiple endpoints supported (stored as JSON array in `localStorage`)
- Failed POSTs logged in the terminal notification panel with HTTP status code
- Retries: one automatic retry after 5 seconds on connection failure

**Trigger:** Automatic on any alert event, once at least one endpoint is configured. Managed via `SET WEBHOOK <url>` command.

**Data Source:** ALERT (event-driven)

---

### F-INT-008 — ERP File Import (CSV / Excel)

**Description:** Provides downloadable import templates and a file upload flow for users who cannot expose ERP APIs. Templates are offered as CSV and XLSX. Uploaded files are parsed entirely in the browser (no server upload).

**Templates:**

| Template | Columns | Fed into |
|---|---|---|
| Procurement contracts | Supplier, Commodity ID, Price, Volume (units), Start Date, End Date | F-PRICE-003 |
| BOM structure | SKU, Ingredient Commodity ID, Weight Per Unit, Unit of Measure | F-PRICE-007 |
| Demand plan | SKU, Month (YYYY-MM), Volume (units) | F-DEMAND-012 |

**Download:** Templates available as CSV and XLSX from the Import panel and via `EXPORT TEMPLATE <name>` command.

**Upload flow:**
1. User downloads template, fills it in their spreadsheet tool, saves as CSV or XLSX
2. User uploads file via drag-and-drop or file picker in the Import panel
3. Terminal validates column headers and data types, surfaces row-level errors
4. On validation pass, data is merged into the in-memory data store and persisted to `localStorage`

**Implementation:**
- XLSX parsing: SheetJS (same library as F-INT-001)
- No file is sent to a server; all parsing is client-side

**Trigger:** Import panel button or `IMPORT <template>` command.

**Data Source:** USER-SUPPLIED

---

### F-INT-009 — Command-Line Interface (CLI)

**Description:** A CLI that exposes the same actions as the terminal command bar, enabling scripted workflows, CI/CD integration, and scheduled automation.

**Supported commands:**
```
dhoomberg export <COMMODITY> --format csv|xlsx --output <path>
dhoomberg alert <COMMODITY> <ABOVE|BELOW> <value> --slack <webhook_url>
dhoomberg refresh --all | --commodity <COMMODITY>
dhoomberg news --commodity <COMMODITY> --last <n>
dhoomberg report --type wasde|eia --latest
```

**Implementation options:**
| Option | Entry point | Runtime |
|---|---|---|
| Node.js CLI | `bin/dhoomberg.js` (npm package, `bin` field in `package.json`) | Node.js ≥ 18 |
| Python CLI | `research/cli.py` | Python ≥ 3.10 |

Both implementations read from the same `public/` JSON data files used by the UI, ensuring consistency between browser and CLI outputs.

**Distribution:**
- Node.js: `npm install -g dhoomberg` (pending npm publish)
- Python: `pip install dhoomberg` (pending PyPI publish)

**Data Source:** CALCULATED / PUBLIC (reads same `public/` files as UI)

---

## API Status Summary

| Integration | Auth type | Key/Credential Source | Status |
|---|---|---|---|
| Google Sheets API | OAuth 2.0 (PKCE, browser-side) | User-supplied GCP client ID | ⚠️ Requires GCP project setup |
| Slack Incoming Webhooks | Webhook URL (no key) | User-supplied URL from Slack app settings | ✅ Standard pattern, no SDK needed |
| Microsoft Teams Webhooks | Webhook URL (no key) | User-supplied URL from Teams channel settings | ✅ Standard pattern, Adaptive Card spec |
| SAP BTP REST API | OAuth client credentials | User-supplied BTP tenant URL + client ID/secret | ⚠️ Requires SAP BTP tenant configuration |
| SAP S/4HANA Public API | API key (x-api-key header) | User-supplied | ⚠️ Requires S/4HANA tenant + API key |
| Oracle Cloud SCM REST | Basic auth / OAuth 2.0 | User-supplied tenant URL + credentials | ⚠️ Untested — endpoint documented by Oracle |
| NetSuite SuiteQL | OAuth 1.0 HMAC-SHA256 | User-supplied Account ID + 4-part OAuth token | ⚠️ Untested — OAuth 1.0 signing in browser needs validation |
| Generic Outbound Webhooks | Optional bearer token | User-supplied per endpoint | ✅ Standard POST pattern |

---

## Data Integration Architecture (High-Level)

```
[User ERP (SAP / Oracle / NetSuite)] ──────────────┐
[Google Sheets (user data)] ───────────────────────┤
[ERP File Upload (CSV / Excel)] ───────────────────►[Import Layer (browser)]
                                                         │
                                                    [In-Memory Data Store]
                                                    [localStorage (credentials
                                                     + imported datasets)]
                                                         │
                                                    [Alert Engine]
                                                    (price, demand, COT)
                                                         │
                          ┌──────────────────────────────┤
                          ▼              ▼               ▼
                    [Slack Webhook] [Teams Webhook] [Generic Webhooks]
                                                         │
                                                    [Export Layer]
                                                    (CSV / XLSX / Sheets)
```

**Production deployment note:** The current architecture is fully client-side. A thin backend will be required for:
1. Google Sheets OAuth 2.0 callback handler (redirect URI must be a registered server endpoint)
2. Scheduled news and public data fetching (to avoid CORS and rate-limit issues)
3. Persistent user configuration across devices (currently `localStorage`-only)

---

## Open Items

- [ ] GCP project setup instructions (OAuth consent screen, Sheets API enable, authorised origins) — to be documented as a setup guide
- [ ] SAP BTP tenant configuration — document required OAuth scopes and service binding steps
- [ ] OAuth callback handler design for production (Node.js/Express or serverless function)
- [ ] Validate NetSuite OAuth 1.0 HMAC-SHA256 signing in browser context (no native crypto issue expected with Web Crypto API)
- [ ] CLI packaging decision: npm publish to public registry vs scoped private package; Python: PyPI vs internal distribution
- [ ] Define `dhoomberg-alert/v1` JSON Schema formally and publish alongside CLI docs
- [ ] Add retry / dead-letter queue design for generic outbound webhooks (currently single retry)
- [ ] Decide on `localStorage` encryption strategy for SAP/Oracle/NetSuite credentials at rest
