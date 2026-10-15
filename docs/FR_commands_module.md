# Functional Requirements — Commands Module
**Dhoomberg Terminal | FMCG & Supply Chain Intelligence**
*Version 0.1 — October 2026*

---

## Overview

The Commands Module defines all action commands accepted by the terminal's command bar — inputs that **do something** rather than navigate to a view or look up a commodity. Navigation commands (PRICE, SHIP, DEMAND, RISK, NEWS, WL) and commodity lookups (SUGAR, COCOA, BRENT, etc.) are handled by the existing routing layer; this document covers the action command vocabulary built on top of it.

All commands share a common parser:

```
raw input  →  uppercase  →  strip trailing <GO>  →  split on whitespace
             [token 0]       [tokens 1…n]
             COMMAND          ARGS
```

If `token 0` is a known action command (ALERT, WATCH, EXPORT, COMPARE, NOTIFY, REFRESH, SET, SLACK, HELP) the remainder of the tokens are passed to that command handler. If `token 0` is a known commodity ticker or navigation keyword, the existing routing layer handles it as before. Unrecognised input shows an inline error:

```
Unknown command: "<INPUT>". Type HELP for the full command list.
```

Malformed arguments to a known command show the syntax hint for that command rather than a generic error.

Action commands are grouped into three types:
- **ALERT / NOTIFY / SLACK** — notification and alerting layer
- **WATCH / COMPARE / REFRESH** — view and data management
- **EXPORT / SET** — data export and user preferences
- **HELP** — command reference

---

## Feature List

---

### F-CMD-001 — ALERT command

**Description:** Creates a price threshold alert for a commodity. When the live price crosses the threshold the terminal shows a red badge on the watchlist row, and optionally fires a browser push notification and POSTs to a Slack webhook (if configured via F-CMD-008).

**Syntax:**
```
ALERT <COMMODITY> ABOVE|BELOW <PRICE> [NOTIFY]
ALERTS
ALERT CLEAR <COMMODITY>
ALERT CLEAR ALL
```

**Examples:**
```
ALERT SUGAR ABOVE 600
ALERT BRENT BELOW 70 NOTIFY
ALERTS
ALERT CLEAR SUGAR
ALERT CLEAR ALL
```

**Behaviour:**
- `ALERT <COMMODITY> ABOVE|BELOW <PRICE>` — stores a threshold record in `localStorage` under key `dhoomberg.alerts`.
- `[NOTIFY]` suffix — marks the alert to trigger a browser `Notification` (Web Notifications API) when it fires. If notification permission has not been granted, the terminal prompts for it at alert-creation time (equivalent to `NOTIFY ON`, F-CMD-005).
- `ALERTS` — lists all active alerts in the command output panel (commodity, direction, threshold, NOTIFY flag, current price, status).
- `ALERT CLEAR <COMMODITY>` — removes all alerts for the named commodity.
- `ALERT CLEAR ALL` — removes every alert in storage.
- At runtime, the price polling loop (or WebSocket feed) evaluates each stored alert on every price tick. On crossing: sets a `fired` flag in the alert record, renders a red badge on the watchlist row, fires the browser notification if flagged, and POSTs to the Slack webhook if configured (F-CMD-008).
- A fired alert is not deleted automatically; it shows as `FIRED` in `ALERTS` output and must be cleared manually.

**Data Source:** CLIENT-SIDE only — `localStorage`; no server required.

**Error messages:**
| Condition | Message shown |
|---|---|
| Missing commodity | `Syntax: ALERT <COMMODITY> ABOVE\|BELOW <PRICE> [NOTIFY]` |
| Unknown commodity | `Unknown commodity: "<TOKEN>". Try SUGAR, COCOA, BRENT, …` |
| Non-numeric price | `Price must be a number. Example: ALERT SUGAR ABOVE 600` |
| NOTIFY without permission and permission denied | `Browser notifications blocked. Allow them in browser settings, then retry.` |

---

### F-CMD-002 — WATCH / UNWATCH command

**Description:** Adds or removes a commodity from the displayed watchlist panel. Persisted in `localStorage` so the watchlist survives page reloads.

**Syntax:**
```
WATCH <COMMODITY>
UNWATCH <COMMODITY>
WATCH LIST
```

**Behaviour:**
- `WATCH <COMMODITY>` — appends the commodity to the watchlist array stored in `localStorage` under `dhoomberg.watchlist`. If the commodity is already present, shows `<COMMODITY> is already on your watchlist.` and takes no further action.
- `UNWATCH <COMMODITY>` — removes the commodity from the stored array. If not found, shows `<COMMODITY> is not on your watchlist.`
- `WATCH LIST` — prints the current watchlist in watchlist-order (the order in which items were added).
- The watchlist panel re-renders immediately on any WATCH / UNWATCH command without a page reload.

**Data Source:** CLIENT-SIDE only — `localStorage`.

**Error messages:**
| Condition | Message shown |
|---|---|
| Missing commodity | `Syntax: WATCH <COMMODITY> or UNWATCH <COMMODITY>` |
| Unknown commodity | `Unknown commodity: "<TOKEN>". Try SUGAR, COCOA, BRENT, …` |

---

### F-CMD-003 — EXPORT command

**Description:** Downloads commodity data as a CSV or JSON file directly from the browser. Covers price history, forecast bands, and leading indicators loaded from `public/`. No server required.

**Syntax:**
```
EXPORT <COMMODITY> [CSV|JSON] [HISTORY|FORECAST|ALL]
EXPORT <COMMODITY> SHEETS
```

**Examples:**
```
EXPORT SUGAR CSV
EXPORT GOLD JSON FORECAST
EXPORT BRENT CSV ALL
EXPORT SUGAR SHEETS
```

**Behaviour:**
- Default format is `CSV`; default dataset is `ALL`.
- `HISTORY` — exports the price history time series (date, price, volume where available).
- `FORECAST` — exports the P10/P50/P90 forecast bands for each forecast date.
- `ALL` — exports all available datasets for the commodity concatenated (or as separate sheets/objects depending on format).
- `CSV` — generates a plain UTF-8 CSV and triggers a `<a download>` browser download. Filename: `dhoomberg_<COMMODITY>_<DATASET>_<YYYYMMDD>.csv`.
- `JSON` — generates a JSON object with top-level keys `history`, `forecast`, `indicators` (whichever are requested) and triggers a download. Filename: `dhoomberg_<COMMODITY>_<DATASET>_<YYYYMMDD>.json`.
- `SHEETS` — opens an OAuth 2.0 authorisation flow to grant Google Sheets write access. On authorisation, writes a new tab named `<COMMODITY> <YYYYMMDD>` into a user-specified Google Sheet. Requires a GCP OAuth client ID configured by the user (see Notes).

**Data Source:** CLIENT-SIDE (reads from the in-memory data store populated from `public/` JSON files) + USER-SUPPLIED (GCP project + OAuth client for SHEETS variant).

**Notes:**
- The SHEETS variant requires the user to provide a GCP project and an OAuth 2.0 client ID with the Google Sheets API enabled. The client ID is stored in `localStorage` under `dhoomberg.gcpClientId`. Without it, `EXPORT <COMMODITY> SHEETS` shows an onboarding message: `GCP client ID not configured. See HELP EXPORT SHEETS.`
- Data exported reflects the currently loaded in-memory state. Run `REFRESH` (F-CMD-006) first to ensure the latest data is used.

**Error messages:**
| Condition | Message shown |
|---|---|
| Unknown commodity | `Unknown commodity: "<TOKEN>". Try SUGAR, COCOA, BRENT, …` |
| Unknown format token | `Syntax: EXPORT <COMMODITY> [CSV\|JSON\|SHEETS] [HISTORY\|FORECAST\|ALL]` |
| No data loaded for dataset | `No <DATASET> data available for <COMMODITY>.` |
| SHEETS — no GCP client ID | `GCP client ID not configured. See HELP EXPORT SHEETS.` |
| SHEETS — OAuth denied | `Google authorisation cancelled. EXPORT SHEETS requires Sheets write permission.` |

---

### F-CMD-004 — COMPARE command

**Description:** Switches the main chart panel to a normalised ratio view that plots two commodities indexed to 100 at the start of the visible range. Shows their correlation coefficient in the panel header. Useful for cross-commodity spread analysis.

**Syntax:**
```
COMPARE <COMMODITY_A> [VS|/] <COMMODITY_B>
COMPARE OFF
```

**Examples:**
```
COMPARE SUGAR COCOA
COMPARE SUGAR VS COCOA
COMPARE BRENT / WTI
COMPARE OFF
```

**Behaviour:**
- `COMPARE <A> <B>`, `COMPARE <A> VS <B>`, or `COMPARE <A> / <B>` are all equivalent. The `VS` and `/` tokens are stripped and treated as separators.
- Switches the chart panel from single-commodity view to a dual-series normalised view: both series are divided by their first visible data point and multiplied by 100, so both start at 100.
- Displays the Pearson correlation coefficient calculated over the visible date range in the panel header (e.g., `Corr: 0.83`). The coefficient recalculates when the user pans or zooms the chart.
- The panel title changes to `<A> vs <B> (indexed to 100)`.
- Any active single-commodity overlays (moving averages, forecasts) are hidden while COMPARE mode is active.
- `COMPARE OFF` — returns to the previously active single-commodity view.
- The active COMPARE pair is stored in component state only; it is not persisted to `localStorage`.

**Data Source:** CLIENT-SIDE — uses price history already loaded in memory for both commodities.

**Error messages:**
| Condition | Message shown |
|---|---|
| Only one commodity given | `Syntax: COMPARE <COMMODITY_A> [VS\|/] <COMMODITY_B>` |
| Same commodity twice | `COMPARE requires two different commodities.` |
| Unknown commodity | `Unknown commodity: "<TOKEN>". Try SUGAR, COCOA, BRENT, …` |
| Insufficient overlapping history | `Insufficient overlapping history for <A> and <B> to compute correlation.` |

---

### F-CMD-005 — NOTIFY command

**Description:** Manages browser push notification permission at the terminal level. Status is shown in the StatusBar.

**Syntax:**
```
NOTIFY ON
NOTIFY OFF
```

**Behaviour:**
- `NOTIFY ON` — calls `Notification.requestPermission()`. If permission is granted, stores `dhoomberg.notifyEnabled = true` in `localStorage` and updates the StatusBar indicator to `🔔 ON`. If denied, shows the denial message and does not update storage.
- `NOTIFY OFF` — sets `dhoomberg.notifyEnabled = false` in `localStorage` and updates the StatusBar to `🔕 OFF`. Does not revoke the browser-level permission (browsers do not expose a programmatic revoke API); the user must revoke it in browser site settings if desired. While OFF, no browser notifications are fired even for alerts that have the NOTIFY flag set.
- On page load, the terminal reads `dhoomberg.notifyEnabled` and reflects the current state in the StatusBar.

**Data Source:** CLIENT-SIDE — Web Notifications API + `localStorage`.

**Notes:**
- `NOTIFY ON` is also triggered implicitly when the user creates an alert with the `[NOTIFY]` flag (F-CMD-001) and permission has not yet been granted.
- Browser notification permission is site-scoped. If the user has previously blocked notifications for the Dhoomberg origin, `Notification.requestPermission()` resolves immediately to `"denied"` without showing a prompt.

**Error messages:**
| Condition | Message shown |
|---|---|
| Missing ON/OFF | `Syntax: NOTIFY ON\|OFF` |
| Permission denied by browser | `Notifications blocked in browser settings. To enable: Site settings → Notifications → Allow.` |
| Browser does not support Notifications API | `Browser notifications are not supported in this browser.` |

---

### F-CMD-006 — REFRESH command

**Description:** Clears the in-memory data cache and re-fetches the specified JSON data file(s) from `public/`. Allows data updates (e.g., after re-running ML forecast scripts) to be reflected without a full page reload.

**Syntax:**
```
REFRESH [ALL|DEMAND|FORECAST|INDICATORS]
```

**Examples:**
```
REFRESH
REFRESH ALL
REFRESH FORECAST
REFRESH INDICATORS
```

**Behaviour:**
- With no argument, or with `ALL` — re-fetches every cached JSON file in `public/` (price history, demand data, forecast outputs, leading indicators).
- `DEMAND` — re-fetches only `public/demand*.json` files.
- `FORECAST` — re-fetches only `public/forecast*.json` files.
- `INDICATORS` — re-fetches only `public/indicators*.json` files.
- During the fetch, a `Refreshing…` message is shown in the command output panel. On completion, shows `Refresh complete — <n> file(s) reloaded.`
- If a fetch fails (HTTP error or network error), shows a per-file error and continues with the remaining files. Successfully loaded files replace the stale cache entries; failed ones retain their previous cached values.
- After refresh, any charts or panels currently displayed are re-rendered with the new data.

**Data Source:** CLIENT-SIDE — `fetch()` against `public/` static files; no server endpoint required.

**Error messages:**
| Condition | Message shown |
|---|---|
| Unknown dataset token | `Syntax: REFRESH [ALL\|DEMAND\|FORECAST\|INDICATORS]` |
| Fetch failure on a file | `Failed to refresh <filename>: <HTTP status or "network error">. Previous data retained.` |

---

### F-CMD-007 — SET command

**Description:** Persists user interface preferences to `localStorage`. Changes take effect immediately without a page reload.

**Syntax:**
```
SET <PREFERENCE> <VALUE>
```

**Examples:**
```
SET LAYOUT COMPACT
SET CURRENCY USD
SET CURRENCY EUR
SET CURRENCY GBP
SET CURRENCY INR
SET THEME DARK
SET THEME LIGHT
```

**Supported preferences:**

| Preference | Allowed values | Default | Effect |
|---|---|---|---|
| `LAYOUT` | `COMPACT` \| `FULL` | `FULL` | `COMPACT` collapses secondary panels and reduces row height across all views |
| `CURRENCY` | `USD` \| `EUR` \| `GBP` \| `INR` | `USD` | Applies a spot-rate multiplier to all displayed prices (see Notes) |
| `THEME` | `DARK` \| `LIGHT` | `DARK` | Adds/removes `data-theme="light"` on the document root element |

**Behaviour:**
- Stores preferences in `localStorage` under `dhoomberg.prefs` as a JSON object.
- On page load, reads stored preferences and applies them before first render.
- `SET CURRENCY <VALUE>` — multiplies all displayed price values by a hardcoded spot-rate lookup table (e.g., `USD → INR: 83.5`). Rate is approximate and for display orientation only; it is not sourced from a live FX feed and is not suitable for trading or procurement calculations. A `~` prefix is shown on converted values to indicate approximation (e.g., `~₹500`).
- `SET THEME DARK|LIGHT` — toggles the `data-theme` attribute on `<html>`. All color tokens react via CSS custom property overrides.

**Data Source:** CLIENT-SIDE — `localStorage` only. FX rates are hardcoded constants, not live data.

**Notes:**
- Currency conversion uses static rates baked into the build. If the user requires accurate FX conversion, they should run `REFRESH` after updating the rates file, or connect a live FX source in a future release.

**Error messages:**
| Condition | Message shown |
|---|---|
| Unknown preference | `Unknown preference: "<TOKEN>". Supported: LAYOUT, CURRENCY, THEME.` |
| Invalid value for preference | `Invalid value "<VALUE>" for SET <PREF>. Allowed: <allowed values list>.` |
| Missing value | `Syntax: SET <PREFERENCE> <VALUE>` |

---

### F-CMD-008 — SLACK command

**Description:** Stores a Slack incoming webhook URL so that fired alerts (F-CMD-001) can POST a notification message to a Slack channel. The webhook URL is stored in `localStorage` and is never sent to any server other than `slack.com`.

**Syntax:**
```
SLACK SET <webhook_url>
SLACK TEST
SLACK OFF
```

**Examples:**
```
SLACK SET https://hooks.slack.com/services/T00/B00/xxxx
SLACK TEST
SLACK OFF
```

**Behaviour:**
- `SLACK SET <webhook_url>` — validates that the URL begins with `https://hooks.slack.com/` and stores it in `localStorage` under `dhoomberg.slackWebhook`. Shows `Slack webhook saved. Use SLACK TEST to verify.`
- `SLACK TEST` — POSTs a test JSON payload (`{"text": "Dhoomberg terminal: Slack integration test."}`) to the stored webhook. On HTTP 200 shows `Slack test message sent.`; on error shows the HTTP status or network error.
- `SLACK OFF` — removes the stored webhook URL and disables Slack posting. Shows `Slack integration disabled.`
- When an alert fires (F-CMD-001) and a webhook is configured and not disabled, the alert handler POSTs a message of the form: `Dhoomberg Alert: <COMMODITY> crossed <ABOVE|BELOW> <PRICE> (current: <LIVE_PRICE>).`
- The Slack POST is fire-and-forget; a failure does not suppress the in-terminal badge or browser notification.

**Data Source:** CLIENT-SIDE — `localStorage` for the URL; outbound HTTP POST to `slack.com` only.

**Notes:**
- The webhook URL grants anyone who possesses it the ability to post to the configured Slack channel. Users should treat it as a secret and avoid sharing terminal sessions. Dhoomberg never transmits the URL to any endpoint other than `slack.com`.

**Error messages:**
| Condition | Message shown |
|---|---|
| URL does not start with `https://hooks.slack.com/` | `Slack webhook URL must start with https://hooks.slack.com/` |
| `SLACK TEST` — no webhook configured | `No Slack webhook configured. Use SLACK SET <webhook_url> first.` |
| `SLACK TEST` — POST fails | `Slack test failed: <HTTP status or "network error">. Check the webhook URL.` |
| Missing subcommand | `Syntax: SLACK SET <url> \| SLACK TEST \| SLACK OFF` |

---

### F-CMD-009 — EXPORT SHEETS command (Google Sheets integration)

**Description:** Extends the EXPORT command (F-CMD-003) with a Google Sheets write target. Opens an OAuth 2.0 authorisation flow and writes commodity data as a new tab in a user-specified Google Sheet.

**Syntax:**
```
EXPORT <COMMODITY> SHEETS
```

**Behaviour:**
- If `dhoomberg.gcpClientId` is not set in `localStorage`, the terminal shows an onboarding message and halts: `GCP client ID not configured. Set it with: SET GCP_CLIENT_ID <your_client_id>. See HELP EXPORT SHEETS for setup steps.`
- If the GCP client ID is configured, initiates the Google OAuth 2.0 implicit flow (`gapi` or direct redirect) requesting the `https://www.googleapis.com/auth/spreadsheets` scope.
- On authorisation, prompts the user for a Google Sheet ID (URL or bare ID). The Sheet ID is stored in `localStorage` under `dhoomberg.sheetsId` for subsequent exports.
- Writes a new tab named `<COMMODITY> <YYYYMMDD>` into the specified Sheet. Tab columns: Date, Price, P10 Forecast, P50 Forecast, P90 Forecast, and any available leading indicator columns.
- If a tab with the same name already exists, appends a numeric suffix (e.g., `SUGAR 20261013_2`).
- On success shows: `Exported to Google Sheets — tab "<tab name>" in sheet <Sheet ID>.`

**Data Source:** CLIENT-SIDE (reads in-memory data) + USER-SUPPLIED (GCP project with Sheets API enabled, OAuth 2.0 client ID configured by the user).

**Notes:**
- This feature requires the user to set up a GCP project, enable the Google Sheets API, and create an OAuth 2.0 client ID (Web application type, with the Dhoomberg origin as an authorised JavaScript origin). This is a one-time setup step.
- The OAuth access token is held in memory only; it is not persisted to `localStorage`.

**Error messages:**
| Condition | Message shown |
|---|---|
| GCP client ID not set | `GCP client ID not configured. Use SET GCP_CLIENT_ID <id>. See HELP EXPORT SHEETS.` |
| OAuth denied | `Google authorisation cancelled. EXPORT SHEETS requires Sheets write permission.` |
| Sheets API write error | `Google Sheets write failed: <API error message>.` |
| Invalid Sheet ID | `Could not open Google Sheet "<ID>". Check the Sheet ID or URL.` |

---

### F-CMD-010 — HELP command

**Description:** Displays the command vocabulary inline in the command output panel. With an optional command name, shows the full syntax, argument table, and examples for that specific command.

**Syntax:**
```
HELP
HELP <COMMAND>
```

**Examples:**
```
HELP
HELP ALERT
HELP EXPORT
HELP SET
```

**Behaviour:**
- `HELP` with no argument — prints a compact reference table of all action commands (command name, one-line description, syntax summary) in the command output panel.
- `HELP <COMMAND>` — prints the full syntax, allowed arguments with their values, and two or three examples for the named command.
- `HELP EXPORT SHEETS` — special case: prints the step-by-step GCP setup instructions in addition to the EXPORT SHEETS syntax.
- HELP output is rendered in the command output panel only; it does not navigate away from the current view.
- The content is static (hardcoded in the command handler); it does not require any data fetch.

**Data Source:** CLIENT-SIDE — static strings in the command handler.

**Error messages:**
| Condition | Message shown |
|---|---|
| Unknown command name given | `No help found for "<TOKEN>". Type HELP to see all commands.` |

---

## Command Parser Architecture

### Current parser (navigation + commodity lookup)

```
raw input  →  trim  →  uppercase  →  strip trailing "<GO>"  →  split on whitespace
```

Token 0 is matched against:
1. Navigation keywords: `PRICE`, `SHIP`, `DEMAND`, `RISK`, `NEWS`, `WL`
2. Commodity tickers: `SUGAR`, `COCOA`, `BRENT`, `WTI`, `GOLD`, …

If matched, the router navigates to the corresponding view.

### Extended parser (action commands, this document)

After the navigation / commodity lookup check fails, token 0 is matched against the action command vocabulary:

```
ALERT | WATCH | UNWATCH | EXPORT | COMPARE | NOTIFY | REFRESH | SET | SLACK | HELP
```

If matched, the remaining tokens (`args = tokens[1…n]`) are passed to the command handler for that action. The handler is responsible for further parsing, validation, and error messages.

```
[token 0]          [tokens 1…n]
COMMAND            ARGS
  │                  │
  ▼                  ▼
command router  → handler(args)
                      │
              ┌───────┴────────┐
              │                │
          execute          show syntax
          action            hint on
                             error
```

### Error handling contract

- **Unknown command** (token 0 not in any known set): `Unknown command: "<INPUT>". Type HELP for the full command list.`
- **Known command, wrong args**: each handler emits its own syntax hint (see individual command sections above). The hint always includes the full `Syntax:` line for that command.
- **Empty input**: no-op; command bar clears.
- Error messages appear inline in the command output panel below the command bar. They do not replace the current view.

### `<GO>` suffix

Bloomberg terminal convention. The string `<GO>` (including the angle brackets) is stripped from the end of any input before tokenisation. This allows muscle-memory users from Bloomberg to append `<GO>` without breaking commands.

### Case normalisation

All input is uppercased before parsing. Command handlers receive uppercase tokens. Commodity tickers, preference names, and direction keywords (`ABOVE`, `BELOW`, `ON`, `OFF`, `VS`) are all uppercase constants.

---

## Open Items

- [ ] Decide whether ALERT state should be exportable / importable (e.g., `ALERTS EXPORT` to share alert configs between browsers)
- [ ] Define the commodity ticker registry — canonical list of valid commodity tokens against which all commands validate
- [ ] Evaluate whether `REFRESH` should support individual commodity names (e.g., `REFRESH SUGAR`) or only dataset-type granularity
- [ ] Confirm GCP OAuth flow: implicit flow (deprecated) vs. PKCE authorisation code flow for EXPORT SHEETS
- [ ] Decide on FX rate update mechanism for `SET CURRENCY` — static constants vs. periodic fetch from a free FX API
- [ ] Define the `SET GCP_CLIENT_ID` preference entry and whether it belongs in the SET command (F-CMD-007) or as a dedicated SHEETS SETUP command
- [ ] Specify COMPARE behaviour when the two commodities have different base currencies (e.g., BRENT in USD vs. a domestic commodity in INR)
- [ ] Add `WATCH MOVE UP|DOWN <COMMODITY>` to reorder watchlist — out of scope for v0.1
- [ ] Determine localStorage key namespace and schema version migration strategy for all persisted state
