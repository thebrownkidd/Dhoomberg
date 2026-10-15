# Functional Requirements — Price Module
**Dhoomberg Terminal | FMCG & Supply Chain Intelligence**
*Version 0.1 — October 2026*

---

## Overview

The Price Module is the core analytical view for any commodity, ingredient, or finished good tracked in the terminal. It surfaces price history, regional distribution, upstream cost chains, competitive positioning, and forecast intelligence in a single unified view.

Data flows from three source types:
- **PUBLIC** — free or low-cost APIs, no user action needed
- **USER-SUPPLIED** — imported from user's ERP/database/flat files
- **CALCULATED** — derived on-platform from the above two

---

## Feature List

---

### F-PRICE-001 — Spot Price & Price History

**Description:** Time-series chart of spot price for a selected commodity/SKU. Supports configurable date ranges (1W / 1M / 3M / 1Y / 5Y / Custom). Overlays for moving averages (7d, 30d, 90d).

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| Global commodity spot prices | World Bank Commodity Data API `api.worldbank.org/v2/country/all/indicator/{CMO_code}` | ✅ Live, no key required |
| India mandi (wholesale) prices | AGMARKNET `agmarknet.gov.in` | ⚠️ HTML scrape only — no public JSON API |
| India producer prices | FAO FAOSTAT `fenixservices.fao.org/faostat/api/v1/en/data/PP` | ❌ Server unreachable (521) — use as fallback only |
| Futures (settlement prices) | MCX / NCDEX exchange feeds | ⚠️ Requires exchange data subscription |

**Notes:**
- World Bank Pink Sheet covers ~70 commodities (grains, oils, metals, energy) monthly. Sufficient for raw materials; not for finished FMCG SKUs.
- For finished goods shelf prices, user must supply data or subscribe to a paid retail panel (Nielsen/IRI).

---

### F-PRICE-002 — Price by Region Map

**Description:** Choropleth map showing price of a selected good across geographies. Supports country-level and state/district-level views for India. Click-through to regional time series.

**Data Source:** PUBLIC + USER-SUPPLIED
| Feed | API / Endpoint | Status |
|---|---|---|
| India wholesale prices by state | AGMARKNET (HTML scrape) | ⚠️ No JSON API, scraping required |
| Global country-level food prices | World Bank `api.worldbank.org/v2` | ✅ Live |
| User's regional price lists | User database / file import | USER-SUPPLIED |

**Notes:**
- Regional granularity below country level requires either user data or AGMARKNET scraping.
- Map tiles: use OpenStreetMap (free) or Mapbox (free tier).

---

### F-PRICE-003 — Contract Price vs. Spot Price

**Description:** Overlay of user's contracted purchase/sale prices against live spot prices. Highlights periods where contract was above/below spot (savings or overpay). Shows contract expiry calendar.

**Data Source:** USER-SUPPLIED
- Procurement contracts (price, volume, supplier, start/end date)
- Sales contracts (price, buyer, tenure)

**Integration:** User imports via CSV/Excel template, ERP connector (SAP MM, Oracle Purchasing), or API push from their system.

---

### F-PRICE-004 — List Price vs. Net Realized Price

**Description:** Waterfall chart showing erosion from list price to net realized price — breakdowns by trade spend category (retailer margin, promotional discount, damage/returns, logistics deductions).

**Data Source:** USER-SUPPLIED
- List price master
- Trade spend actuals by deduction type
- Net invoiced value

**Integration:** ERP (SAP SD/FI), trade promotion management systems (Exceedra, SAP TPM, Accenture Edge).

---

### F-PRICE-005 — Price by Channel

**Description:** Bar/table view comparing price realization across modern trade, general trade, e-commerce, and institutional channels for the same SKU.

**Data Source:** USER-SUPPLIED
- Channel-wise sales data (price × volume)

**Integration:** User's sales system or data warehouse.

---

### F-PRICE-006 — Price per Unit of Measure

**Description:** Normalized price view (per kg, per litre, per unit) across pack sizes. Enables price-pack architecture analysis — which pack size delivers what effective price per unit.

**Data Source:** USER-SUPPLIED (SKU master + price) + CALCULATED
- Pack size and unit weight/volume from user's product master
- Effective price per UOM = (net realized price) / (pack size in UOM)

---

### F-PRICE-007 — Raw Material & Intermediate Price Chain

**Description:** Waterfall or tree view showing the price of each input in the bill of materials (BOM), from raw commodity → intermediate → finished good. Updates automatically as commodity prices move.

**Data Source:** PUBLIC (raw materials) + USER-SUPPLIED (BOM structure)
| Feed | API | Status |
|---|---|---|
| Commodity prices (grains, oils, sugar, etc.) | World Bank `api.worldbank.org/v2` | ✅ Live |
| Energy (crude, gas, power) | EIA `api.eia.gov` | ⚠️ Free registration required — 1,000 req/hour |
| Freight (container, bulk) | Baltic Exchange / Freightos FBX | ⚠️ Limited free tier; FBX index is publicly quoted |
| User BOM structure | User database | USER-SUPPLIED |

**Notes:**
- EIA requires free API key registration at `eia.gov/opendata`. Returns clean JSON.
- BOM must be supplied by user with ingredient → commodity mapping.

---

### F-PRICE-008 — Futures Curve (Contango / Backwardation)

**Description:** Forward curve chart for key input commodities showing the full term structure. Indicates whether market expects tightness (backwardation) or oversupply (contango). Useful for procurement timing decisions.

**Data Source:** PUBLIC (exchange-sourced)
| Feed | Status |
|---|---|
| MCX futures (India) — metals, agri | ⚠️ Requires MCX data subscription |
| NCDEX futures (India) — agri | ⚠️ Requires NCDEX data subscription |
| CME Group (global) | ⚠️ Requires CME data license for real-time; 10-min delay free via CME website |
| ICE Futures | ⚠️ Requires ICE data subscription |

**Notes:**
- Free alternative: USDA WASDE projections provide a coarser forward view on key agri commodities. ESMIS API available but needs testing (`esmis.nal.usda.gov`).

---

### F-PRICE-009 — Input Cost Index

**Description:** A single weighted index number reflecting the total landed cost of inputs for a given product, recalculated daily as commodity prices update. User defines weights based on their BOM.

**Data Source:** CALCULATED
- Formula: `Σ (commodity_price_t × weight_in_BOM)` normalized to a base period (e.g., Jan 2020 = 100)
- Inputs: commodity prices (F-PRICE-007 sources) + user BOM weights (USER-SUPPLIED)

---

### F-PRICE-010 — Freight & Energy as Price Components

**Description:** Decomposition panel showing how freight costs and energy costs contribute to the landed cost of a product. Updates as freight indices and energy prices move.

**Data Source:** PUBLIC + CALCULATED
| Feed | API | Status |
|---|---|---|
| Crude oil price | EIA or World Bank | ✅ / ⚠️ (key needed for EIA) |
| Baltic Dry Index (bulk freight) | Baltic Exchange | ⚠️ Limited free; widely scraped |
| Container freight index (FBX) | Freightos | ⚠️ Index published freely; detailed routes require subscription |
| India domestic freight | No public API — user-supplied or sourced from 3PL invoices | USER-SUPPLIED |

---

### F-PRICE-011 — Price Index vs. Category Average

**Description:** Compares a user's product price against the category average price index. Shows whether the brand is trading at a premium or discount, and tracks that gap over time.

**Data Source:** USER-SUPPLIED + PAID COMMERCIAL
- User's own price: from F-PRICE-004/F-PRICE-005
- Category average: Nielsen Retail Index / IRI / Circana (paid), or user manually inputs competitor shelf prices

**Integration:** Paid data vendors deliver via SFTP or API. User can also manually enter competitor prices as a lighter alternative.

---

### F-PRICE-012 — Competitor Price Positioning

**Description:** Table/chart showing price of user's SKUs versus nearest competitors. Tracks premium/discount gap over time. Includes share-of-shelf price positioning (where does user's price sit in the category range).

**Data Source:** USER-SUPPLIED + PAID COMMERCIAL + OPTIONAL WEB SCRAPE
- Nielsen/IRI panel data (paid)
- E-commerce price scrapers (BigBasket, Blinkit, Amazon) — feasible via scraping layer
- Manual user entry

---

### F-PRICE-013 — Private Label Price Gap

**Description:** Tracks the price premium of branded product versus private label equivalent. Critical indicator of switching risk and brand equity.

**Data Source:** USER-SUPPLIED + PAID COMMERCIAL
- Same as F-PRICE-012 for private label SKUs

---

### F-PRICE-014 — 52-Week High / Low & Price Range Rank

**Description:** Shows current price relative to 52-week range. Displays where today's price sits historically (percentile rank over 1Y, 3Y, 5Y).

**Data Source:** CALCULATED from F-PRICE-001 history

---

### F-PRICE-015 — Price Volatility (Realized)

**Description:** Rolling realized volatility of price — 30-day and 90-day annualized standard deviation of daily returns. Helps procurement teams size hedging positions and forecast budget risk.

**Data Source:** CALCULATED from F-PRICE-001 time series

---

### F-PRICE-016 — Price-at-Risk

**Description:** Estimates maximum likely price increase over a forward horizon (e.g., 30 days) at a given confidence level (95%). Based on historical volatility of input cost index.

**Data Source:** CALCULATED
- Formula: `PAR = Input_Cost_Index × Volatility × Z_score × √(horizon_days/252)`
- Uses F-PRICE-009 (input cost index) + F-PRICE-015 (volatility)

---

### F-PRICE-017 — Pass-Through Rate

**Description:** Measures how much of an input cost increase the company has historically passed through to shelf prices. Regression of Δ shelf price on Δ input cost index over rolling 12-month windows.

**Data Source:** CALCULATED
- Inputs: F-PRICE-004 (net realized price) + F-PRICE-009 (input cost index)
- Output: rolling regression coefficient (0 = no pass-through, 1 = full pass-through)

---

### F-PRICE-018 — Price Realization Rate

**Description:** Percentage of a list price increase that actually lands at shelf after trade deductions. If list price goes up ₹5 but net realized price only goes up ₹3, realization rate = 60%.

**Data Source:** CALCULATED from USER-SUPPLIED data
- Formula: `Δ Net Realized Price / Δ List Price × 100`

---

### F-PRICE-019 — Affordability Index

**Description:** Price of a standard pack as a percentage of average daily wage in a given region. Tracks consumer affordability trends, particularly relevant for emerging market FMCG.

**Data Source:** PUBLIC + CALCULATED
| Feed | API | Status |
|---|---|---|
| Average daily wage by country | World Bank `api.worldbank.org/v2/country/{iso}/indicator/SL.EMP.WORK.ZS` | ✅ Live |
| India state-level wages | Ministry of Labour / MOSPI | ⚠️ Available in reports, no clean API |
| Product price | F-PRICE-004 | CALCULATED |

---

### F-PRICE-020 — Forecast & Scenario Engine

**Description:** Forward-looking price forecast for a commodity or input cost index. Combines statistical models with user-adjustable scenario assumptions.

**Sub-features:**

**F-PRICE-020a — Baseline Forecast**
Statistical forecast using STL decomposition + ARIMA or Prophet model. Generates P10/P50/P90 confidence bands.
- Source: CALCULATED from F-PRICE-001 time series

**F-PRICE-020b — Scenario Overlays**
User defines bull/base/bear scenarios by adjusting key driver assumptions (crude +10%, crop yield -15%, freight spike). Platform recalculates input cost index under each scenario.
- Source: USER-SUPPLIED (assumptions) + CALCULATED

**F-PRICE-020c — Forecast vs. Actuals Trail**
Rolling comparison of previous forecasts against actuals. Shows MAPE (Mean Absolute Percentage Error), bias direction (consistently over/under), and best/worst forecast horizons.
- Source: CALCULATED from stored forecast history + actuals

**F-PRICE-020d — User Model Integration**
Allow user to push their own forecast model outputs via API or file upload. Platform ingests and displays alongside system forecast for comparison.
- Source: USER-SUPPLIED

---

### F-PRICE-021 — Leading Indicators Panel

**Description:** Panel of external signals that historically lead price movements for a selected commodity. Includes futures prices, weather anomalies, crop condition reports, and freight rates.

**Data Source:** PUBLIC
| Indicator | Feed | API | Status |
|---|---|---|---|
| Crop production outlook | USDA WASDE | `esmis.nal.usda.gov/api/v1/reports.json` | ⚠️ Redirects — needs further testing |
| Crop condition index | USDA NASS | `quickstats.nass.usda.gov/api` | ⚠️ Free API key required |
| Weather anomaly index | NOAA | `api.weather.gov` | ⚠️ Free, US-focused; IMD for India (no JSON API) |
| India crop production | Ministry of Agriculture seasonal reports | No clean API — PDF scrape / manual | ❌ |
| Container freight rates | Freightos FBX | Public index page | ⚠️ No free API for historical data |

---

### F-PRICE-022 — Seasonal Decomposition View

**Description:** Decomposes a price time series into trend, seasonal, and residual components using STL (Seasonal and Trend decomposition using Loess). Allows users to strip seasonality and see the underlying price trend.

**Data Source:** CALCULATED from F-PRICE-001

---

## API Status Summary

| API | Key Required | Cost | Tested Status | Recommended Use |
|---|---|---|---|---|
| World Bank Data API | No | Free | ✅ Live | Commodity spot prices, wages |
| EIA (US Energy) | Yes (free registration) | Free | ⚠️ Untested — key needed | Crude, gas, electricity |
| USDA FAS PSD Online | No | Free | ❌ 404 on tested endpoint | Crop supply/demand balance |
| USDA WASDE via ESMIS | No | Free | ⚠️ Redirects to new URL | Crop outlook, price forecasts |
| FAO FAOSTAT | No | Free | ❌ Server 521 — unreliable | Producer prices (fallback) |
| AGMARKNET (India) | No | Free | ✅ Site live, no JSON API | India mandi prices (scrape) |
| Open Food Facts | No | Free | ✅ Live, clean JSON | Product ingredient data |
| MCX / NCDEX | Yes (subscription) | Paid | Not tested | India commodity futures |
| CME / ICE | Yes (license) | Paid | Not tested | Global commodity futures |
| Nielsen / IRI | Yes (contract) | Paid | Not tested | Competitor pricing, category index |
| Baltic Exchange | Partial free | Freemium | Not tested | Bulk freight index |
| Freightos FBX | No (index) | Free index | ⚠️ Site live, API paid | Container freight |

---

## Data Integration Architecture (High-Level)

```
[Public APIs] ──────────────────────────┐
[Exchange Feeds] ────────────────────── ▼
[Paid Data Vendors] ──────────────► [Data Ingestion Layer]
                                         │
[User ERP / Database] ──────────────────┤
[User File Uploads (CSV/Excel)] ─────── │
[User API Push] ─────────────────────── ▼
                                    [Unified Data Store]
                                         │
                                    [Calculation Engine]
                                         │
                                    [Price Module UI]
```

**User integration methods (to be designed):**
1. File import (CSV/Excel) — for price masters, contracts, BOM
2. ERP connector — SAP, Oracle, Microsoft Dynamics
3. Webhook / REST API push — user's systems push data to Dhoomberg endpoint
4. User-defined model API — user provides forecast endpoint, Dhoomberg calls it on schedule

---

## Open Items

- [ ] Confirm MCX/NCDEX data licensing costs and API format
- [ ] Test EIA API after free registration
- [ ] Evaluate USDA NASS API for crop condition data (free key required)
- [ ] Determine scraping feasibility for AGMARKNET (rate limits, ToS)
- [ ] Evaluate Freightos FBX paid API pricing
- [ ] Design BOM import template and commodity mapping schema
- [ ] Decide forecasting model: Prophet vs ARIMA vs user-defined
- [ ] Define base period for Input Cost Index (F-PRICE-009)
