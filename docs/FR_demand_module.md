# Functional Requirements — Demand Module
**Dhoomberg Terminal | FMCG & Supply Chain Intelligence**
*Version 0.1 — October 2026*

---

## Overview

The Demand Module surfaces consumption-side signals that drive commodity prices: how much is being consumed globally, whether industrial activity is accelerating or contracting, how tight supply is relative to demand, and where financial markets expect demand to go. It sits alongside the Price and Shipment modules and provides the demand leg of the supply–demand balance analysis.

Data flows from three source types:
- **PUBLIC** — free or low-cost APIs, no user action needed
- **USER-SUPPLIED** — imported from user's ERP/S&OP/demand planning system
- **CALCULATED** — derived on-platform from the above two

---

## Feature List

---

### F-DEMAND-001 — Global Consumption Volume Tracker

**Description:** Time-series of annual global consumption volumes for a selected commodity, by country and by region. Shows which markets are growing or contracting. Supports overlay of production volumes to derive implied surplus/deficit.

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| Grains, oilseeds, cotton, sugar | USDA PSD Online `apps.fas.usda.gov/psdonline/app/index.html#/app/downloads` | ⚠️ Bulk CSV download, no per-query JSON API |
| All food commodities (global) | FAO FAOSTAT `fenixservices.fao.org/faostat/api/v1/en/data/FBS` | ❌ Server 521 — unreliable, use as fallback |
| Metals & mining (production = proxy for demand) | World Steel Association `worldsteel.org/steel-by-topic/statistics` | ⚠️ Free monthly PDF; no public JSON API |
| Energy demand by country | IEA World Energy Balances | ❌ Paid subscription only |

**Notes:**
- USDA PSD is the authoritative source for grains, oilseeds, cotton, and sugar. Annual frequency only; updated monthly in WASDE cycle.
- For metals, global production figures (aluminium, copper, zinc) from industry associations are the best free proxy for demand.
- Energy demand at country level requires IEA subscription; use EIA (US-only, free) or WB World Development Indicators as partial substitutes.

---

### F-DEMAND-002 — Industrial Production & Manufacturing Activity

**Description:** Panel of manufacturing PMI and industrial production indices. These are the primary leading indicators of demand for base metals, energy, and packaging materials. Displayed as time series with expansion/contraction threshold (PMI = 50).

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| US Industrial Production (INDPRO) | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=INDPRO` | ✅ Live, no key, monthly 1919– |
| US ISM Manufacturing PMI | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=NAPM` | ✅ Live, no key, monthly 1948– |
| OECD Composite Leading Indicator | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=USALOLITONOSTSAM` | ✅ Live, no key, monthly 1960– |
| China NBS Manufacturing PMI | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=CHNMFPMI` (check series ID) | ⚠️ Series availability on FRED to be confirmed |
| Global Manufacturing PMI (JPMorgan) | S&P Global monthly press release | ⚠️ Free headline number only; full index requires subscription |
| Euro Area Industrial Production | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=EUPROINDMISMEI` | ✅ Live, no key |

**Notes:**
- INDPRO and NAPM (ISM PMI) are the most reliable, longest-running, and directly correlate with base metal and energy demand.
- China PMI matters more than US PMI for copper, iron ore, aluminium — China accounts for ~50% of global base metal consumption. Confirm FRED series ID before implementation.
- PMI is a diffusion index: values > 50 = expansion, < 50 = contraction. Display with threshold line.

---

### F-DEMAND-003 — EIA Crude Oil & Petroleum Demand Tracker

**Description:** Weekly US crude oil and petroleum product inventory levels and implied demand (four-week average product supplied). Inventory draws signal demand exceeding supply; builds signal the reverse. The most timely demand signal for crude benchmarks.

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| US crude oil inventories (WTISTUS) | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=WTISTUS` | ✅ Live, no key, weekly 1982– |
| US petroleum products supplied (implied demand) | EIA `api.eia.gov/v2/petroleum/cons/wpsup/data/` | ⚠️ Free, requires EIA API key (free registration at eia.gov/opendata) |
| Natural gas storage | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=DHHNGSP` | ✅ Live, no key (storage report also via EIA API) |
| Refinery utilization rate | EIA API `api.eia.gov/v2/petroleum/move/...` | ⚠️ Free, requires EIA API key |

**Notes:**
- WTISTUS (crude inventories) is available free via FRED with no key — start here.
- EIA API returns clean JSON after free key registration. Covers crude, petroleum products, natural gas, and electricity.
- Weekly inventory change (week-over-week draw or build) is the most watched short-term demand signal for WTI/Brent.

---

### F-DEMAND-004 — USDA WASDE Supply/Demand Balance Sheet

**Description:** Monthly global supply and demand balance for major agricultural commodities (wheat, corn, soybeans, rice, cotton, sugar, oilseeds). Shows production, consumption, ending stocks, and the stocks-to-use ratio. Tight stocks-to-use is the most reliable leading indicator of price spikes in grains.

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| WASDE report (PDF) | USDA NASS `usda.gov/oce/commodity/wasde` | ✅ Free monthly PDF |
| USDA PSD programmatic access | USDA FAS `apps.fas.usda.gov/psdonline/app/index.html#/app/downloads` | ⚠️ Bulk CSV downloads; `api.fas.usda.gov/api/psd` REST endpoint exists but 404'd in prior testing — needs retest |
| ESMIS (USDA) | `esmis.nal.usda.gov/api/v1/reports.json` | ⚠️ Redirects in prior testing — endpoint to be confirmed |

**Key Metrics to Surface:**
- Ending stocks (Mt)
- Ending stocks-to-use ratio (%) — threshold: below 15% = historically tight for grains
- USDA vs prior-month revision (demand revision direction)
- Year-on-year consumption growth by major importer (China, India, EU)

**Notes:**
- The stocks-to-use ratio is the single most powerful agricultural demand signal. Price spikes in corn, wheat, and soy correlate strongly with stocks-to-use falling below historical averages.
- USDA PSD REST API existence to be confirmed — if unavailable, parse monthly CSV bulk download.

---

### F-DEMAND-005 — China Demand Dashboard

**Description:** Dedicated panel for China's industrial demand signals — the single largest driver of global commodity demand for metals and energy. Surfaces production, import, and activity data in one view.

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| China steel production (monthly) | World Steel Association short-range outlook / monthly press release | ⚠️ Free PDF; no JSON API |
| China industrial production index | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=CHNMFPMI` or `INDPROCNM659N` | ⚠️ Series ID to be confirmed |
| China imports by commodity | UN Comtrade `comtradeapi.un.org` | ⚠️ Free tier: 500 req/month; monthly data |
| China copper imports | Customs General Administration (GAC) — relayed by Bloomberg, Reuters | ❌ No free API; available from financial wire services |
| China PMI (Caixin) | Caixin/S&P Global press release | ⚠️ Free headline number; history requires subscription |
| China NBS PMI | NBS of China `stats.gov.cn` | ⚠️ Site live; JSON endpoint not documented, requires scraping |

**Key Metrics:**
- China manufacturing PMI (Caixin + NBS)
- Monthly steel output (% YoY)
- Monthly copper imports (% YoY) — China imports ~60% of global copper
- Fixed asset investment growth — construction drives steel and copper

**Notes:**
- Start with FRED series for available China indicators and UN Comtrade for import volumes.
- China data has a 30–45 day publication lag; display release date prominently.

---

### F-DEMAND-006 — FAO Food Price Index

**Description:** The FAO Food Price Index (FFPI) and its five sub-indices (cereals, vegetable oils, dairy, meat, sugar). Published monthly. A composite demand/price signal covering the full basket of food commodities.

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| FFPI monthly index (2002–2004 = 100) | FAO `fao.org/worldfoodsituation/foodpricesindex/en/` — CSV download | ✅ Free, downloadable CSV |
| Sub-indices (cereals, oils, dairy, meat, sugar) | Same FAO page | ✅ Free |
| FAOSTAT API | `fenixservices.fao.org/faostat/api/v1/en/data/CP` | ❌ Server 521 in prior testing — use direct CSV download instead |

**Notes:**
- FAO publishes an Excel file (`Food_Price_Indices_data_jul25.xlsx` format) monthly. Parse this directly.
- The FFPI is widely cited by commodity traders; spikes in the index historically precede social unrest and food security events in import-dependent countries.
- Useful as a cross-check for model forecasts: if FFPI rises and our grain forecasts don't, review model assumptions.

---

### F-DEMAND-007 — CFTC Commitment of Traders (Speculative Positioning)

**Description:** Weekly net speculative positioning (managed money long minus short) in major commodity futures contracts. Financial demand — hedge funds and speculators going long increases price pressure; crowded shorts can fuel sharp reversals.

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| CFTC COT report (weekly) | CFTC `cftc.gov/MarketReports/CommitmentsofTraders/index.htm` | ✅ Free, weekly CSV |
| COT via FRED | FRED (selected series: e.g. `DCOILWTICO` for crude) | ✅ Free, for key contracts |
| Disaggregated COT (managed money separate) | CFTC disaggregated reports | ✅ Free, same site |

**Contracts to track:** WTI crude (CL), natural gas (NG), gold (GC), silver (SI), copper (HG), corn (ZC), wheat (KE), soybeans (ZS), sugar (SB), cotton (CT), coffee (KC).

**Key Metrics:**
- Net speculative position (long − short, contracts)
- Change week-over-week
- Position as % of open interest — >15% net long = crowded

**Notes:**
- COT is released every Friday for the prior Tuesday's positions.
- Extreme net long speculative positions are a contrarian signal: crowded longs precede corrections.
- COT data is available as free weekly CSV back to 1986; parse once and update weekly.

---

### F-DEMAND-008 — Baltic Dry Index & Shipping Demand

**Description:** The Baltic Dry Index (BDI) and its sub-indices (Capesize, Panamax, Supramax) as a proxy for physical commodity trade demand. A rising BDI signals more commodities being shipped globally; useful for iron ore, coal, grain, and fertilizer price forecasting.

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| Baltic Dry Index | Baltic Exchange `balticexchange.com/en/index.html` | ⚠️ Free headline daily; history requires subscription |
| BDI via Yahoo Finance | Yahoo Finance (`^BDI` if available) | ⚠️ Availability to be confirmed |
| BDI via FRED | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU` (check for BDI series) | ⚠️ FRED does not appear to carry BDI — confirm |
| Freightos Baltic Index (container) | Freightos `fbx.freightos.com` | ✅ Free index level; historical API paid |

**Notes:**
- BDI history can be sourced from financial data aggregators. If Yahoo Finance carries `^BDI`, use the same `fetch_yahoo.py` infrastructure already in place.
- Capesize (large bulk) most correlated with iron ore; Panamax correlated with grain and coal.
- For supply chain context, container freight indices (FBX, SCFI) are more relevant than dry bulk for packaged FMCG.

---

### F-DEMAND-009 — LME & Exchange Warehouse Stocks

**Description:** Official warehouse inventory levels reported by the LME (London Metal Exchange) for aluminium, copper, nickel, zinc, lead, and tin. Low warehouse stocks relative to consumption days indicate physical tightness and support higher prices.

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| LME daily warehouse stocks | LME `lme.com/en/metals/non-ferrous` — data section | ⚠️ Free daily data on site; no official JSON API; scraping feasible |
| COMEX gold/silver warehouse | CME Group `cmegroup.com/delivery-reporting/warehouse-stocks` | ⚠️ Free report; no API |
| LME stocks via data vendors | Quandl/NASDAQ Data Link, Refinitiv | ⚠️ Paid |

**Key Metrics:**
- Warehouse stocks in metric tonnes
- Days of consumption (stocks / daily consumption rate — requires CALCULATED step)
- Week-over-week change
- Cancelled warrants % (inventory earmarked for delivery — leading indicator of drawdown)

**Notes:**
- LME publishes daily warehouse reports in PDF and on the website. Scraping is feasible and widely done.
- Cancelled warrants as a % of total stock is a sharper signal than raw stock level.

---

### F-DEMAND-010 — Consumer Confidence & End-Market Demand

**Description:** Consumer spending and confidence indicators as proxies for end-market demand for consumer goods. Relevant for commodities that feed into packaged food, beverages, and personal care (sugar, cocoa, coffee, vegetable oils, cotton).

**Data Source:** PUBLIC
| Feed | API / Endpoint | Status |
|---|---|---|
| US Consumer Sentiment (Michigan) | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=UMCSENT` | ✅ Live, no key, monthly 1952– |
| OECD Consumer Confidence | FRED `fred.stlouisfed.org/graph/fredgraph.csv?id=CSCICP03USM665S` | ✅ Live, no key |
| India Consumer Confidence | RBI Consumer Confidence Survey | ⚠️ Quarterly PDF; no API |
| EM consumer spending proxy | World Bank household consumption expenditure | ✅ Annual only; too lagged for tactical use |
| India FMCG volume growth | Nielsen/Kantar retail reports | ❌ Paid; quarterly |

**Notes:**
- US Michigan Consumer Sentiment and OECD CCI are the most tractable free monthly series.
- For FMCG-specific demand, consumer confidence is a coarse proxy. More precise signals require Nielsen/Kantar panel data (paid).
- Useful for softs (cocoa, coffee, cotton) and sugar where consumer income elasticity is meaningful.

---

### F-DEMAND-011 — Seasonal Demand Calendar

**Description:** Calendar heat map showing the seasonal demand cycle for each commodity category — planting and harvest seasons for grains, construction season for metals, heating season for energy, monsoon crush for sugar. Overlaid with current-year deviations from seasonal norms.

**Data Source:** CALCULATED + PUBLIC
- Seasonal patterns: derived from STL decomposition of price and consumption time series (ML-02 output already provides seasonal amplitudes)
- Current deviation from seasonal norm: CALCULATED from latest F-DEMAND-001/F-DEMAND-004 data
- Reference calendar: US/India/Brazil crop calendars from USDA (static, codified once)

**Key Commodities and Their Cycles:**
| Commodity | Key Seasonal Driver | Peak Demand Period |
|---|---|---|
| Wheat | Northern hemisphere harvest pressure | May–Aug (harvest = price low); Sep–Oct (new-crop demand) |
| Corn / Maize | US crop cycle | Mar–May (planting anxiety); Aug–Sep (harvest) |
| Soybeans | US + Brazil dual-hemisphere cycle | Jan–Mar (Brazil harvest); Aug–Nov (US harvest) |
| Sugar | Brazil crush season | Apr–Nov (supply peak); Jan–Mar (inter-crop tightness) |
| Natural Gas | Heating/cooling demand | Nov–Feb (northern hemisphere heating) |
| Crude Oil | Driving season + heating season | May–Aug (US summer driving); Dec–Feb (heating) |
| Cotton | Planting to harvest | Mar–May (planting); Sep–Nov (US harvest, price pressure) |

---

### F-DEMAND-012 — User's Internal Demand Plan

**Description:** The user's own demand forecast and actual sales volume for their products. Enables comparison of internal procurement needs against external commodity demand signals, and drives "how much do I need to hedge" calculations.

**Data Source:** USER-SUPPLIED
- Demand plan: volume by SKU, month, region (from user's S&OP or demand planning system)
- Actuals: shipped volume by SKU (from user's ERP or sales system)

**Derived Outputs (CALCULATED):**
- Implied raw material requirements (volume × BOM weight per ingredient)
- Coverage ratio: months of forward procurement vs months of forward demand
- Demand forecast error (MAPE of user's demand plan vs actuals)

**Integration:** CSV/Excel import template; ERP connector (SAP IBP, Oracle Demantra, Kinaxis); API push.

**Notes:**
- This feature transforms the terminal from market intelligence into a procurement decision support tool. The combination of F-DEMAND-012 + F-PRICE-007 (BOM cost chain) + F-PRICE-016 (Price-at-Risk) gives a user a quantified view of their forward cost exposure.

---

### F-DEMAND-013 — Demand Shock Alerts

**Description:** Automated alerts triggered when a demand signal crosses a threshold that historically precedes price movement. Examples: USDA WASDE stocks-to-use drops below a commodity-specific alert level; COT net speculative position exceeds 15% of open interest; PMI falls below 48 for two consecutive months.

**Data Source:** CALCULATED from F-DEMAND-001 through F-DEMAND-010

**Alert Types:**
| Alert | Trigger | Commodities |
|---|---|---|
| Tight stocks | WASDE stocks-to-use < 15% for grains, < 8% for sugar | WHEAT, MAIZE, RICE, SUGAR |
| Speculative squeeze | COT net managed-money long > 15% of OI | All futures-traded commodities |
| Demand contraction | PMI < 48 for two consecutive months | Base metals, energy |
| Inventory draw streak | EIA crude inventories draw 4+ consecutive weeks | BRENT, WTI, DUBAI |
| China PMI shock | Caixin/NBS PMI drops > 2 points month-on-month | COPPER, ALU, NICKEL, IRON |

---

## API Status Summary

| API | Key Required | Cost | Tested Status | Recommended Use |
|---|---|---|---|---|
| FRED (INDPRO, NAPM, WTISTUS, UMCSENT, OECD CLI) | No | Free | ✅ Live | Industrial demand, inventories, consumer confidence |
| EIA Open Data API | Yes (free registration) | Free | ⚠️ Untested — key needed | Petroleum demand, gas storage, refinery utilization |
| USDA PSD Bulk CSV | No | Free | ✅ Downloadable | WASDE balance sheet data |
| USDA FAS API (`api.fas.usda.gov/api/psd`) | No | Free | ❌ 404 in prior testing — retest needed | Per-query WASDE data |
| FAO Food Price Index CSV | No | Free | ✅ Live download | FFPI and sub-indices |
| CFTC COT weekly CSV | No | Free | ✅ Live | Speculative positioning |
| LME warehouse stocks | No (scrape) | Free | ⚠️ Scraping required | Metal physical demand/tightness |
| UN Comtrade API | No (free tier) | Free / Paid | ⚠️ 500 req/month free | China trade volumes |
| Baltic Dry Index | No (headline) | Free headline | ⚠️ History may require vendor | Bulk shipping demand |
| World Steel Association | No | Free (PDF) | ⚠️ PDF only | China/global steel output |
| China NBS PMI | No (scrape) | Free | ⚠️ Scraping required | China manufacturing activity |

---

## Open Items

- [ ] Confirm FRED series ID for China Manufacturing PMI (`CHNMFPMI` or equivalent)
- [ ] Register for free EIA API key and test petroleum demand endpoints
- [ ] Retest USDA FAS API (`api.fas.usda.gov/api/psd`) — 404'd previously
- [ ] Confirm whether Yahoo Finance carries `^BDI` (Baltic Dry Index) for free history
- [ ] Design scraping layer for LME warehouse stocks (daily update cadence)
- [ ] Evaluate UN Comtrade free tier (500 req/month) for China import volume coverage
- [ ] Define alert thresholds per commodity for F-DEMAND-013 (pre-register before implementation)
- [ ] Map F-DEMAND-012 user demand plan import template to existing BOM schema from F-PRICE-007
