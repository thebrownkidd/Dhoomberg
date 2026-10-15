# Dhoomberg — Data Sources & API Inventory

Every external data source the platform uses, grouped by access tier. All sources are wired behind `DEMO_MODE` in `src/data/config.ts` — the mock layer is a drop-in replacement; swapping to live data means setting `DEMO_MODE = false` and supplying the relevant keys.

---

## Tier 1 — Free, No Key Required

These can be connected immediately with no registration.

| Source | Endpoint / Feed | Powers |
|---|---|---|
| **World Bank Pink Sheet (monthly)** | `CMO-Historical-Data-Monthly.xlsx`, linked from worldbank.org/en/research/commodity-markets (link changes monthly; `research/fetch_data.py` resolves it) | Monthly average prices 1960–present for sugar, palm oil, wheat, maize, soybean oil, cocoa, coffee, Brent, cotton, rice, aluminium. Not SMP. **Not available via the `api.worldbank.org/v2` indicators API** (tested: returns invalid value). |
| **Yahoo Finance futures (unofficial)** | `query1.finance.yahoo.com/v8/finance/chart/{SYM}=F` | Daily front-month futures 2000–present, used by ML-01. Research only; production should use licensed CME/ICE data. |
| **OFAC SDN List** | `treasury.gov/ofac/downloads/sdn.xml` | Sanctions screening (US) |
| **EU Consolidated Sanctions List** | `data.europa.eu/api/hub/...` (CSV/XML) | Sanctions screening (EU) |
| **UN Security Council Sanctions** | `scsanctions.un.org/resources/xml/en/consolidated.xml` | Sanctions screening (UN) |
| **HM Treasury Sanctions List** | `gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets` | Sanctions screening (UK) |
| **Freightos FBX Public Index** | `fbx.freightos.com` (public JSON) | Global ocean freight cost index — input to chokepoint reroute cost |

---

## Tier 2 — Free, Registration Required

Register once; key goes in `.env`; all free at the volumes we need.

| Source | Register | What you get | Powers |
|---|---|---|---|
| **EIA Open Data** | eia.gov/developer | Brent crude, WTI, Henry Hub gas, diesel | Energy cost component in price waterfall; chokepoint reroute fuel surcharge |
| **NOAA Climate Data Online (CDO)** | ncdc.noaa.gov/cdo-web | Historical + near-real-time weather by station/region | Crop risk overlay; seasonal forecast inputs |
| **USDA NASS QuickStats** | quickstats.nass.usda.gov/api | US crop production, yield estimates, acreage | Leading indicators panel; supply-side price drivers |
| **ACLED (Armed Conflict Location & Event Data)** | acleddata.com/access-data | Conflict events by country/region | Chokepoint geopolitical threat score; risk alert drivers |

---

## Tier 3 — Paid (User Brings Their Own Key)

These are enterprise data subscriptions. Production users of Dhoomberg are expected to hold these already (FMCG companies have Nielsen/IRI, exchanges have MCX/CME access). The platform exposes a key-configuration screen; keys are never stored server-side.

| Source | What it powers | Notes |
|---|---|---|
| **MCX (Multi Commodity Exchange, India)** | INR-denominated futures for sugar, palm, maize, wheat | Exchange subscription required |
| **NCDEX (National Commodity & Derivatives Exchange)** | Indian agri-commodity futures | Exchange subscription required |
| **CME Group Market Data** | Global futures curves: CBOT wheat/corn/soy, ICE sugar/cocoa/coffee | CME DataMine or real-time feed subscription |
| **ICE Data Services** | Brent futures, cotton, coffee C, cocoa | Can be bundled with CME |
| **Nielsen / NielsenIQ** | Competitor shelf prices, private label price gap, price by channel | Enterprise contract; powers F-PRICE-007, F-PRICE-009, F-PRICE-012 |
| **IRI (Circana)** | Alternative/complement to Nielsen; same use case | Enterprise contract |
| **Freightos FBX Pro API** | Lane-level freight rates (not just the public index) | Paid tier at freightos.com |
| **MarineTraffic AIS API** | Real-time vessel positions, port congestion, ETA | Powers F-SHIP-002 chokepoint live vessel flow |
| **VesselFinder** | Alternative AIS source | Same use case as MarineTraffic |

---

## Tier 4 — User-Supplied (No API — Import / Integration)

These fields come from the user's own systems and are never sourced externally. The platform provides an import UI and/or API endpoint for each.

| Data | Source system | Relevant features |
|---|---|---|
| Contract prices (buy/sell) | ERP / procurement system | F-PRICE-001 spot vs. contract spread |
| List prices & net realized prices | Trade promotion management system | F-PRICE-002, F-PRICE-003 |
| Price by channel / SKU / pack size | ERP / POS data | F-PRICE-004, F-PRICE-005 |
| Price realization rates | Revenue management system | F-PRICE-011 |
| User forecast models | Internal models (Excel, Python, proprietary) | F-PRICE-016 forecast vs. actuals |
| Bill of Materials (BOM) | ERP / product master | F-PRICE-013 input cost index |
| Shipment records & carrier performance | TMS / freight forwarder | F-SHIP-001 active shipments |
| Supplier risk scores | Procurement / supplier master | F-SHIP-004 composite risk score |

---

## Tier 5 — Scrape-Dependent (No Public API)

These sources have no JSON API and require a web scraper or manual export. Treat as low-priority until volume justifies maintaining a scraper.

| Source | Data | Status |
|---|---|---|
| **AGMARKNET** (agmarknet.gov.in) | Indian wholesale mandi prices by commodity & market | Scrape required; no API; consider weekly batch export |
| **FAO FAOSTAT** | Annual food price indices, production stats | API exists but returned 521 errors in testing; use World Bank CMO as fallback |
| **USDA FAS PSD Online** | Global supply/demand projections by commodity | API returned 404 in testing; use manual CSV export as fallback |

---

## Environment Variables

All keys go in `.env` at the project root (gitignored). The app reads them at build time via Vite's `import.meta.env`.

```env
# Tier 2 — Free, requires registration
VITE_EIA_API_KEY=
VITE_NOAA_CDO_TOKEN=
VITE_USDA_NASS_KEY=
VITE_ACLED_KEY=

# Tier 3 — Paid (user supplies)
VITE_MCX_API_KEY=
VITE_CME_API_KEY=
VITE_NIELSEN_API_KEY=
VITE_FREIGHTOS_API_KEY=
VITE_MARINE_TRAFFIC_API_KEY=
```

`DEMO_MODE` in `src/data/config.ts` remains `true` until at least one real source is configured. Individual connectors check for their own key and fall back gracefully to mock data if absent.
