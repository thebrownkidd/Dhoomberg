# Functional Requirements — Shipment & Supply Chain Module
**Dhoomberg Terminal | FMCG & Supply Chain Intelligence**
*Version 0.1 — October 2026*

---

## Overview

The Shipment & Supply Chain Module surfaces risk intelligence across active trade lanes, chokepoints, carrier performance, compliance exposure, and supplier risk. Its primary output is a composite **Shipment Risk Score** per lane and supplier relationship — designed to feed into demand forecasting and safety stock models.

Live shipment visibility (vessel/container tracking) and in-transit inventory are scoped as low-priority integration features. The module's analytical core is items F-SHIP-001 through F-SHIP-006.

Data flows from three source types:
- **PUBLIC** — free or low-cost APIs, no user action needed
- **USER-SUPPLIED** — from user's TMS / ERP / procurement data
- **CALCULATED** — derived on-platform from the above two
- **PAID** — commercial data subscriptions (mocked in demo)

---

## Feature List

---

### F-SHIP-001 — Predictive Delay Scoring

**Description:** A per-shipment delay probability score (0–100%) with expected delay in days and a P10/P50/P90 confidence band. Covers ocean, air, and road modes. Updated on each new AIS position fix or carrier milestone event.

**Model inputs:**
- Current vessel position vs. scheduled position (AIS delta)
- Port congestion index at destination (berth queue, average dwell time)
- Historical carrier schedule reliability on that lane
- Weather severity on active route
- Season (quarter) as a learned feature
- Vessel age (proxy for reliability)

**Model type:** Gradient boosting (XGBoost / LightGBM) trained on user's historical actuals vs. planned. Per-lane models where data is sufficient; global fallback model otherwise.

**Output fields:**
- `delay_probability` — % chance of arrival >2 days late
- `expected_delay_days` — P50 estimate
- `confidence_band` — P10 / P90 range
- `primary_driver` — top contributing factor (e.g. "port congestion: Rotterdam")
- `last_updated` — timestamp of last position fix

**Data Sources:**
| Feed | Endpoint | Status |
|---|---|---|
| AIS vessel position data | Spire Maritime API / MarineTraffic API | Paid · mock in demo |
| Port congestion / dwell time | Portcast API | Paid · mock in demo |
| Carrier schedule reliability | Sea-Intelligence (monthly index) | Paid · summary free |
| Weather on route | NOAA / DTN routing weather | Free (NOAA) / Paid (DTN) |
| Historical shipment actuals | User TMS / ERP | USER-SUPPLIED |

**Notes:**
- Minimum training data: ~200 historical shipments per lane for a lane-specific model. Below that, fallback to global model.
- NOAA marine weather API is free and covers global ocean routing. Sufficient for weather input feature.

---

### F-SHIP-002 — Chokepoints & Corridor Status

**Description:** Live status dashboard for the world's key maritime chokepoints and trade corridors. Three-layer scoring: physical throughput, geopolitical threat, and operational cost impact. Each chokepoint has a **Corridor Threat Level (1–5)** and a **Transit Time Index** (current vs. 90-day average).

**Chokepoints covered:**
| Chokepoint | Key Risk | Reroute Option |
|---|---|---|
| Suez Canal | Closure / congestion | Cape of Good Hope |
| Panama Canal | Water level / draught restriction | Suez or US land bridge |
| Red Sea / Bab el-Mandeb | Houthi attack zone | Cape of Good Hope |
| Strait of Hormuz | Iran sanctions / military tension | N/A — no viable alternative |
| Strait of Malacca | Piracy / congestion | Lombok / Sunda Strait |
| Bosphorus | Seasonal restrictions / Turkey policy | N/A |
| Cape of Good Hope | Weather (roaring forties) | Baseline route when Suez avoided |

**Three scoring layers:**

**Layer 1 — Physical Throughput**
- Vessels per day through chokepoint (AIS count)
- Current transit time vs. 90-day moving average
- Queue/waiting vessels count
- Source: AIS aggregate data

**Layer 2 — Geopolitical Threat**
- Incident count (last 30 days) on corridor
- Advisory level from UKMTO / IMB Piracy Reporting Centre (both publish free advisories)
- Derived threat score normalized 1–5
- Source: UKMTO advisories (free), Lloyd's List Intelligence (paid), Windward (paid)

**Layer 3 — Operational Cost Impact**
- Rerouting cost delta ($/TEU) if chokepoint is avoided
- Additional transit days
- Fuel cost delta based on extra nautical miles × current bunker price
- Recalculated daily as freight rates and fuel prices update
- Source: Calculated from lane distance data + freight rate indices + EIA bunker prices

**Output per chokepoint:**
- `threat_level` — 1 (clear) to 5 (critical)
- `transit_time_index` — current hours / 90-day avg hours
- `vessel_queue` — ships waiting
- `reroute_cost_delta` — $/TEU vs. direct route
- `reroute_days_added` — additional transit days
- `last_incident` — most recent advisory event with date

**Data Sources:**
| Feed | Endpoint | Cost | Status |
|---|---|---|---|
| AIS aggregate (chokepoint transit) | MarineTraffic / Spire | Paid | Mock in demo |
| UKMTO maritime advisories | ukmto.org/reports | Free | ✅ Live |
| IMB Piracy Reporting Centre | icc-ccs.org/imb | Free (PDF) | ⚠️ No JSON API |
| Lloyd's List Intelligence | API | Paid | Mock in demo |
| Windward vessel risk | API | Paid | Mock in demo |
| EIA bunker / fuel price | api.eia.gov | Free (key) | ⚠️ Key required |
| Lane distance data | Static table | N/A | Built-in |

---

### F-SHIP-003 — Sanctions & Trade Restrictions Screening

**Description:** Automated compliance screening for every active shipment. Three sub-screens run in sequence: entity screening, vessel risk screening, and trade lane compliance. Output is a per-shipment compliance status with reason codes.

**Sub-feature F-SHIP-003a — Entity Screening**
Screens all parties in a shipment (supplier, carrier, vessel owner, freight forwarder, port agent, consignee) against live sanctions watchlists. Match = flagged with matched list entry, entity name, and date listed.

Watchlists screened:
- OFAC SDN List (US)
- OFAC Non-SDN Consolidated List
- EU Consolidated Sanctions List
- UN Security Council Consolidated List
- HM Treasury (UK) Financial Sanctions

Update frequency: within 24h of any list change.

**Sub-feature F-SHIP-003b — Vessel Risk Screening**
Screens vessels against AIS behavioural signals that indicate evasion or sanctions exposure:
- AIS dark period (transponder off >12h in open water)
- Flag change within last 6 months
- Ownership change within last 12 months
- Ship-to-ship transfer in high-risk zone
- Port call in sanctioned jurisdiction

Output: `vessel_risk_score` (0–100) with flagged behaviour list.
Source: Windward / Pole Star (paid), AIS data.

**Sub-feature F-SHIP-003c — Trade Lane Compliance**
For a given HS code + origin country + destination country, returns:
- Applicable MFN tariff rate
- Any anti-dumping / countervailing duties
- Export control classification (EAR / ITAR flag)
- FTA eligibility and applicable preferential rate
- Active import bans or quotas

**Data Sources:**
| Feed | Endpoint | Cost | Status |
|---|---|---|---|
| OFAC SDN List | ofac.treas.gov (XML/CSV daily) | Free | ✅ Live |
| EU Consolidated Sanctions List | eeas.europa.eu | Free | ✅ Live |
| UN Security Council List | un.org/securitycouncil | Free | ✅ Live |
| HM Treasury UK list | gov.uk/government/publications | Free | ✅ Live |
| TARIC (EU tariff database) | ec.europa.eu/taxation_customs/dds2/taric | Free | ✅ Live |
| US HTS tariff schedule | usitc.gov | Free | ✅ Live |
| India customs tariff | cbic.gov.in | Free (PDF) | ⚠️ No JSON API |
| Vessel AIS + risk scoring | Windward / Pole Star | Paid | Mock in demo |

**Notes:**
- OFAC, EU, and UN lists are free, machine-readable, and updated frequently. The entity screening layer can be built entirely on free data.
- Vessel behavioural risk requires AIS history, which is paid. Demo uses pre-scored mock vessels.
- Trade lane tariff lookup requires building a tariff code database locally from TARIC + HTS source files.

---

### F-SHIP-004 — Carrier & Lane Performance

**Description:** Carrier performance scorecard across four dimensions: reliability, transit time, booking integrity, and claims rate. Benchmarked against Sea-Intelligence industry averages by trade lane.

**The four dimensions:**

**Dimension 1 — Schedule Reliability**
- % of sailings arriving within ±1 day of scheduled arrival
- Source: Sea-Intelligence monthly carrier reliability index (paid, summary free)
- Benchmark: current global average ~70–75% (Sea-Intelligence publishes this)

**Dimension 2 — Transit Time Performance**
- Actual transit time vs. lane benchmark (days)
- Rolling 90-day average actual vs. carrier published schedule
- Source: User's historical shipment data + AIS actuals

**Dimension 3 — Booking Integrity**
- % of confirmed bookings that actually departed on the booked vessel
- "Rolled cargo" rate — how often the carrier bumped the shipment to a later sailing
- Source: USER-SUPPLIED from user's TMS/ERP

**Dimension 4 — Claims Rate**
- Cargo damage/loss claims per 1,000 shipments
- Source: USER-SUPPLIED from user's insurance / claims system

**Composite Carrier Score:** weighted average of four dimensions (weights user-configurable). Output: score 0–100 + RAG status per carrier per lane.

**Lane benchmarks included:**
- Asia–Europe (Transhipment hubs: Singapore, Port Klang)
- Asia–North America West Coast
- Asia–North America East Coast (via Suez or Panama)
- Europe–India
- Intra-Asia
- India domestic (road)

**Data Sources:**
| Feed | Endpoint | Cost | Status |
|---|---|---|---|
| Sea-Intelligence schedule reliability | sea-intelligence.com | Paid (summary free) | ⚠️ Summary index public |
| User historical shipment actuals | User TMS / ERP | USER-SUPPLIED | — |
| User claims data | User insurance system | USER-SUPPLIED | — |
| AIS actuals for transit time | Spire / MarineTraffic | Paid | Mock in demo |

---

### F-SHIP-005 — Supply Chain Risk Scoring

**Description:** A 0–100 composite risk score per supplier and origin country, built on four dimensions: concentration risk, supplier financial health, geopolitical risk, and climate/physical risk. Updated monthly (or on trigger event).

**The four dimensions:**

**Dimension 1 — Concentration Risk**
- % of total procurement volume sourced from single supplier (single-source ratio)
- % of total volume from top-3 origin countries (geographic concentration)
- Herfindahl–Hirschman Index (HHI) of supplier base — standard economic concentration measure
- Source: USER-SUPPLIED procurement data

**Dimension 2 — Supplier Financial Health**
- Credit risk score / probability of default
- Days payable outstanding trend (proxy for financial stress)
- Source: D&B Supplier Risk, RapidRatings, Moody's Analytics (all paid)
- Free proxy: check for public financial filings where available

**Dimension 3 — Geopolitical Risk**
- World Bank Worldwide Governance Indicators (WGI) — political stability, rule of law, regulatory quality
- ACLED conflict event count (last 90 days) within 200km of supplier location
- Export policy risk: history of export bans / controls on key commodities from that country
- Source: World Bank WGI API (free), ACLED API (free for research)

**Dimension 4 — Climate / Physical Risk**
- Flood risk score at supplier location
- Drought/water stress index (critical for agri supply chains)
- Cyclone / extreme weather exposure
- Source: ND-GAIN Country Index (free), NOAA climate data (free), Four Twenty Seven / Jupiter Intelligence (paid for location-level)

**Composite formula:**
```
Risk_Score = w1×Concentration + w2×Financial + w3×Geopolitical + w4×Climate
```
Default weights: 30% / 25% / 25% / 20%. User-configurable.

**Output per supplier:**
- `risk_score` — 0 (low) to 100 (critical)
- `rag_status` — Green (<40) / Amber (40–70) / Red (>70)
- `top_risk_driver` — highest-contributing dimension
- `concentration_ratio` — % of spend from this supplier
- `country_risk_score` — geopolitical + climate sub-score
- `last_updated` — date of last score refresh

**Data Sources:**
| Feed | Endpoint | Cost | Status |
|---|---|---|---|
| World Bank WGI (political stability) | api.worldbank.org/v2/country/{iso}/indicator/PV.EST | Free | ✅ Live |
| ACLED conflict events | acleddata.com/api | Free (research) | ⚠️ Registration required |
| ND-GAIN Country Index | gain.nd.edu/our-work/country-index | Free (CSV download) | ✅ Live |
| D&B Supplier Risk | D&B API | Paid | Mock in demo |
| Four Twenty Seven / Jupiter | API | Paid | Mock in demo |
| User procurement data | User ERP / database | USER-SUPPLIED | — |

---

### F-SHIP-006 — Composite Shipment Risk Score

**Description:** The integration layer. Combines outputs from F-SHIP-001 through F-SHIP-005 into a single per-lane and per-supplier risk score. This score feeds into the Price Module's forecast engine and safety stock recommendations.

**Formula:**
```
Shipment_Risk_Score = f(
  delay_probability,         ← F-SHIP-001
  corridor_threat_level,     ← F-SHIP-002
  compliance_status,         ← F-SHIP-003  (0=clean, 50=flagged, 100=blocked)
  carrier_reliability_inv,   ← F-SHIP-004  (inverted: low reliability = high risk)
  supplier_risk_score        ← F-SHIP-005
)
```

Default aggregation: weighted average. Weights user-configurable. Compliance status overrides: a "blocked" status forces score to 100 regardless of other inputs.

**Output:**
- `lane_risk_score` — 0–100 per origin→destination lane
- `supplier_risk_score` — 0–100 per supplier
- `risk_trend` — improving / stable / deteriorating (30-day direction)
- `top_driver` — which sub-score is driving the composite
- `forecast_signal` — recommended safety stock adjustment (days of cover to add/remove based on score movement)

**Forecast integration:**
The `forecast_signal` output is the bridge to the Price Module and demand planning:
- Score >70 and rising → flag for safety stock build
- Score <40 and falling → flag for safety stock reduction
- Corridor threat spike → trigger rerouting cost recalculation in Price Module (F-PRICE-010)
- Supplier risk >80 → trigger single-source dependency alert and suggest alternative supplier scoring

---

## Low Priority Items (Future Integration)

### F-SHIP-LOW-001 — Live Shipment Visibility
Active shipment map, vessel/container tracking by BL/container number, multi-modal timeline. Dependent on AIS data subscription (paid). Full value realized once F-SHIP-001 delay model is live.

### F-SHIP-LOW-002 — In-Transit Inventory
Value and volume of goods in transit, days-of-supply in pipeline per SKU. Dependent on user's ERP integration providing real-time inventory positions. Feeds into safety stock model alongside F-SHIP-006 forecast signal.

---

## API Status Summary

| API | Key Required | Cost | Tested Status | Use |
|---|---|---|---|---|
| OFAC SDN List | No | Free | ✅ Live | Entity screening |
| EU Consolidated Sanctions List | No | Free | ✅ Live | Entity screening |
| UN Security Council List | No | Free | ✅ Live | Entity screening |
| HM Treasury UK List | No | Free | ✅ Live | Entity screening |
| TARIC EU Tariff | No | Free | ✅ Live | Trade lane compliance |
| US HTS Tariff | No | Free | ✅ Live | Trade lane compliance |
| World Bank WGI | No | Free | ✅ Live | Geopolitical risk |
| ACLED Conflict Events | Yes (free reg) | Free | ⚠️ Key required | Geopolitical risk |
| ND-GAIN Country Index | No | Free (CSV) | ✅ Live | Climate risk |
| NOAA Weather | Yes (free reg) | Free | ⚠️ Key required | Weather/delay risk |
| UKMTO Advisories | No | Free | ✅ Live (HTML) | Chokepoint threat |
| Sea-Intelligence Reliability | — | Paid | ⚠️ Summary free | Carrier benchmarks |
| AIS Data (Spire / MarineTraffic) | Yes | Paid | Not tested | Vessel tracking / delay |
| Portcast | Yes | Paid | Not tested | Port congestion |
| Windward / Pole Star | Yes | Paid | Not tested | Vessel risk / sanctions |
| D&B Supplier Risk | Yes | Paid | Not tested | Supplier financial health |
| Lloyd's List Intelligence | Yes | Paid | Not tested | Chokepoint incidents |
| Four Twenty Seven / Jupiter | Yes | Paid | Not tested | Climate/physical risk |

---

## Open Items

- [ ] Test ACLED API after free registration — confirm data coverage for key FMCG origin regions (India, SEA, West Africa)
- [ ] Test NOAA marine weather API for routing weather feature input
- [ ] Evaluate ND-GAIN CSV data structure for automated ingestion
- [ ] Design sanctions screening update scheduler — frequency and delta detection
- [ ] Confirm TARIC and HTS tariff database schema for local build
- [ ] Define default composite score weights and user-override UX
- [ ] Design supplier onboarding flow — how user maps their supplier list to countries/coordinates for risk scoring
- [ ] Evaluate AIS data providers: Spire Maritime vs MarineTraffic vs exactEarth — cost and API quality
- [ ] Define `forecast_signal` output schema for Price Module integration (F-PRICE-020 handoff)
- [ ] Define minimum historical data requirement for lane-level delay model vs. global fallback threshold
