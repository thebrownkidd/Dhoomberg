# Dhoomberg — Machine Learning Requirements
**Dhoomberg Terminal | FMCG & Supply Chain Intelligence**
*Version 0.1 — October 2026*

---

## Overview

This document lists every ML model or statistical learning task required across the Price and Shipment modules. Each entry defines the objective, what data we train on, and what the model outputs. Sources reference the corresponding FR features.

Models are grouped by type: time-series forecasting, regression, classification, scoring, and anomaly detection.

---

## ML-01 — Commodity Price Forecast

> **Status (Oct 2026): v1 built and validated. See [ML01_forecast_report.md](ML01_forecast_report.md).** It passes at 1–3 months (+20% / +6% / +4% skill vs no-change, significant, calibrated bands) and has no proven edge at 4–12 months. The design below was the starting plan; v1 is ridge regression with a futures nowcast. Prophet/ARIMA was not used, because univariate models did not beat no-change in testing.

**Source feature:** F-PRICE-020a  
**Type:** Time-series forecasting

### Objective
Generate a forward price forecast for any tracked commodity or input cost index, with uncertainty bands. Used by procurement teams for hedging, budgeting, and procurement timing.

### Training Data
| Feature | Source | Notes |
|---|---|---|
| Daily/weekly spot price history | World Bank CMO, EIA, exchange feeds | Min 5 years; more is better |
| Futures curve (term structure) | CME / MCX / NCDEX | Forward prices as a leading signal |
| Seasonal calendar | Derived from historical data | Harvest months, weather seasons |
| Macroeconomic indicators | World Bank (GDP growth, inflation) | Annual cadence; interpolated |
| Weather anomaly index | NOAA | Drought/flood index by crop region |
| Crop production reports | USDA NASS, FAO | Quarterly |

**Minimum viable training set:** 5 years of weekly price history per commodity (260 observations). More data = better seasonal decomposition.

### Model
- Primary: **Facebook Prophet** (additive model: trend + seasonality + regressors). Easy to add exogenous regressors (crop reports, weather). Interpretable.
- Alternative: **ARIMA with exogenous variables (ARIMAX / SARIMAX)** for commodities with strong autocorrelation structure.
- Ensemble: average Prophet + SARIMAX predictions, weighted by recent MAPE.

### Output
```
{
  "commodity_id": "SUGAR",
  "forecast_horizon_days": 90,
  "p10": [price_array],   // pessimistic
  "p50": [price_array],   // base case
  "p90": [price_array],   // optimistic
  "trend_direction": "up" | "down" | "flat",
  "key_drivers": ["drought_index", "futures_contango"],
  "mape_30d": 4.2,        // rolling accuracy on last 30 days
  "bias": "over" | "under" | "neutral"
}
```

---

## ML-02 — Seasonal Decomposition

**Source feature:** F-PRICE-022  
**Type:** Statistical decomposition

### Objective
Decompose any price series into trend, seasonal, and residual components. Lets users strip out seasonality to see the underlying structural price trend — critical for procurement decisions and budget planning.

### Training Data
| Feature | Source |
|---|---|
| Price history (at least 2 full seasonal cycles) | World Bank, EIA, exchange feeds, user-supplied |

**Minimum viable:** 2 years of weekly data (104 observations). STL requires at least 2 complete seasonal periods.

### Model
**STL (Seasonal and Trend decomposition using Loess)** — industry standard for this task. Non-parametric, handles missing data, robust to outliers.

Parameters to tune: seasonal window length (7–52 weeks depending on commodity), trend smoother span.

### Output
```
{
  "commodity_id": "PALM",
  "dates": [...],
  "trend": [float_array],
  "seasonal": [float_array],
  "residual": [float_array],
  "seasonal_strength": 0.72,   // 0=no seasonality, 1=fully seasonal
  "trend_direction": "up"
}
```

---

## ML-03 — Input Cost Pass-Through Rate

**Source feature:** F-PRICE-017  
**Type:** Regression

### Objective
Measure how much of an input cost increase the company has historically passed through to shelf prices. A rolling regression of Δ shelf price on Δ input cost index. Tells procurement and pricing teams the effective pricing power.

### Training Data
| Feature | Source |
|---|---|
| Net realized price over time | User-supplied (ERP / trade promotion system) |
| Input cost index over time | Calculated (F-PRICE-009) from commodity prices + BOM weights |
| List price change events | User-supplied (price master history) |
| Volume sold per period | User-supplied (sales system) |

**Minimum viable:** 12 months of monthly data. 3+ years gives stable rolling windows.

### Model
**OLS rolling regression** over a 12-month window, refit monthly.
```
Δ shelf_price_t = α + β × Δ input_cost_index_t + ε
```
β is the pass-through coefficient: 0 = no pass-through, 1 = full pass-through, >1 = over-recovery.

Add channel as a categorical feature (modern trade vs. general trade) for a per-channel version.

### Output
```
{
  "product_id": "SKU-001",
  "period": "2026-Q3",
  "pass_through_rate": 0.61,       // 61% of input cost increase passed to shelf
  "alpha": -0.02,                   // baseline price drift
  "r_squared": 0.78,
  "window_months": 12,
  "channel_breakdown": {
    "modern_trade": 0.72,
    "general_trade": 0.54
  }
}
```

---

## ML-04 — Leading Indicators Panel (Price Drivers)

**Source feature:** F-PRICE-021  
**Type:** Correlation / Granger causality

### Objective
Identify which external signals (futures prices, weather anomalies, crop reports, freight rates) historically lead price movements for a given commodity — and by how many weeks. Surfaces these as a ranked panel so users know what to watch.

### Training Data
| Feature | Source |
|---|---|
| Commodity spot price history | World Bank, exchange feeds |
| Futures prices at various tenors | CME, MCX, NCDEX |
| Crop condition index | USDA NASS |
| Drought/flood anomaly index | NOAA |
| Container freight index | Freightos FBX |
| Crude oil price | EIA |
| Relevant exchange rates | World Bank or ECB |

**Minimum viable:** 5 years of weekly data for both the target price and each candidate leading indicator.

### Model
1. **Cross-correlation analysis** at lags 1–26 weeks — identify lag of maximum correlation for each indicator.
2. **Granger causality test** — confirm a signal statistically Granger-causes the price (not just correlated).
3. Rank indicators by strength of lead relationship.

Re-run quarterly to catch structural changes (e.g., a new supply-demand dynamic makes freight rates more predictive than before).

### Output
```
{
  "commodity_id": "COCOA",
  "leading_indicators": [
    {
      "indicator": "futures_3m",
      "lead_weeks": 4,
      "correlation": 0.81,
      "granger_p_value": 0.003,
      "direction": "positive"
    },
    {
      "indicator": "west_africa_rainfall_anomaly",
      "lead_weeks": 8,
      "correlation": -0.67,
      "granger_p_value": 0.011,
      "direction": "negative"
    }
  ]
}
```

---

## ML-05 — Predictive Delay Scoring

**Source feature:** F-SHIP-001  
**Type:** Classification (probability output)

### Objective
Per-shipment delay probability (0–100%) with expected delay in days and P10/P50/P90 confidence bands. Updated on each new AIS position fix or carrier event.

### Training Data
| Feature | Source | Notes |
|---|---|---|
| Planned arrival date | User TMS / ERP | Label anchor |
| Actual arrival date | User TMS / ERP | Label: delay = actual − planned |
| Vessel position at each milestone (AIS deltas) | Spire / MarineTraffic | Paid |
| Port congestion index at destination | Portcast API | Paid; or proxy from AIS dwell |
| Carrier historical schedule reliability | Sea-Intelligence index | Paid (summary free) |
| Weather severity on route at time of sailing | NOAA marine forecast | Free |
| Season / quarter | Derived | Learned feature |
| Vessel age | Vessel registry | Free (IMO data) |
| Origin–destination lane | User TMS | Categorical feature |
| Cargo type (container / bulk / reefer) | User TMS | Categorical feature |

**Label:** `delay_days = actual_arrival − planned_arrival`. Binary classification target: `delayed = 1 if delay_days > 2 else 0`. Also train a regression head for expected delay days.

**Minimum viable training set:** 200 completed shipments per lane for a lane-specific model. Below that, use a global model across all lanes. Cold-start: use industry Sea-Intelligence baselines until enough user data accumulates.

### Model
- **XGBoost or LightGBM** gradient-boosted tree classifier (well-suited to tabular data with mixed types).
- Two-head architecture: classification head (delay yes/no) + regression head (expected delay days).
- Retrain monthly as new completed shipments are added. Per-lane models where data allows; global fallback otherwise.
- Feature importance tracked and surfaced as `primary_driver` in the output.

### Output
```
{
  "shipment_id": "SHP-2026-4421",
  "delay_probability": 0.73,
  "expected_delay_days": 3.2,
  "confidence_band": { "p10": 1.0, "p90": 7.5 },
  "primary_driver": "port_congestion:Rotterdam",
  "secondary_driver": "carrier_reliability:MSC",
  "last_updated": "2026-10-12T08:00Z"
}
```

---

## ML-06 — Corridor Threat Scoring (Geopolitical Layer)

**Source feature:** F-SHIP-002 Layer 2  
**Type:** Scoring model (rule-based + weighted signals)

### Objective
Produce a Corridor Threat Level (1–5) for each chokepoint that integrates incident counts, advisory severity, and historical attack patterns. Updated daily.

### Training Data / Inputs
| Signal | Source | Notes |
|---|---|---|
| Incident count last 30 days on corridor | ACLED API | Free (registration required) |
| UKMTO advisory level | UKMTO (free HTML) | Parsed daily |
| IMB Piracy Reporting Centre alerts | IMB PDF feed | Parsed; no clean API |
| Lloyd's List Intelligence incident scores | Paid API | Mock in demo |
| Historical attack frequency by corridor | ACLED historical | Used to set baseline expectations |

**This is not a trained ML model.** It is a weighted scoring rule calibrated against historical ground truth (known corridor closures / severe disruption events):
```
Threat_Level = clip(
  w1 × normalized_incident_count_30d +
  w2 × advisory_severity_score +
  w3 × historical_base_risk,
  1, 5
)
```

Weights (default): 50% / 30% / 20%. Tuned against known events (Suez closure 2021, Red Sea 2023–24, Panama Canal 2023 drought).

### Output
```
{
  "chokepoint": "RED_SEA",
  "threat_level": 4,
  "incident_count_30d": 7,
  "advisory_level": "HIGH",
  "primary_driver": "houthi_attacks",
  "last_incident_date": "2026-10-10",
  "score_components": { "incident": 0.80, "advisory": 0.85, "base": 0.60 }
}
```

---

## ML-07 — Vessel Behavioural Risk (AIS Anomaly Detection)

**Source feature:** F-SHIP-003b  
**Type:** Anomaly detection / rule-based scoring

### Objective
Score each vessel (0–100) for sanctions-evasion or high-risk behavior based on AIS behavioral signals: transponder gaps, ship-to-ship transfers, flag changes, port calls in sanctioned jurisdictions.

### Training Data / Inputs
| Signal | Source |
|---|---|
| AIS position history (gaps, dark periods) | Spire / MarineTraffic (paid) |
| Flag and ownership change history | Vessel registry / Lloyd's Vessel Register |
| Historical port calls | AIS data |
| Known high-risk zones (sanctioned ports, STS transfer zones) | Static reference table (OFAC, UN) |
| Verified sanctioned vessels (positive labels) | OFAC / Windward known-bad list |

**Hybrid approach:**
1. **Rule-based flags** for hard signals (AIS dark >12h in open water, port call in sanctioned jurisdiction, flag change in <6 months). Each flag adds a fixed score increment.
2. **Anomaly detection (Isolation Forest or DBSCAN)** on the continuous AIS trajectory features to catch unusual patterns not covered by hard rules.

### Output
```
{
  "vessel_imo": "9481674",
  "vessel_risk_score": 68,
  "flags": [
    { "type": "ais_dark_period", "duration_hours": 18, "location": "Gulf of Oman" },
    { "type": "flag_change", "from": "Panama", "to": "Comoros", "months_ago": 3 }
  ],
  "anomaly_score": 0.71,
  "last_assessed": "2026-10-12"
}
```

---

## ML-08 — Supply Chain Risk Scoring (Supplier / Country)

**Source feature:** F-SHIP-005  
**Type:** Composite scoring (multi-dimensional weighted model)

### Objective
Score each supplier (0–100) on supply chain risk across four dimensions: concentration, financial health, geopolitical exposure, and climate/physical risk. Used to prioritize diversification and trigger safety stock adjustments.

### Training Data / Inputs

**Dimension 1 — Concentration Risk (calculated from user data)**
| Feature | Source |
|---|---|
| Spend per supplier (% of total) | User ERP / procurement data |
| Spend per origin country (% of total) | User ERP |
| HHI (Herfindahl–Hirschman Index) of supplier base | Calculated |

**Dimension 2 — Supplier Financial Health**
| Feature | Source |
|---|---|
| Credit risk score / PD | D&B Supplier Risk (paid); Moody's Analytics (paid) |
| Days payable outstanding trend | User ERP (proxy for their own financial stress on the supplier) |
| Public financial filings | Company registries (free where available) |

**Dimension 3 — Geopolitical Risk**
| Feature | Source |
|---|---|
| World Bank WGI: political stability, rule of law | World Bank API (free) |
| ACLED conflict event count within 200km (last 90 days) | ACLED API (free, registration) |
| Export ban / restriction history | Manual table + news monitoring |

**Dimension 4 — Climate / Physical Risk**
| Feature | Source |
|---|---|
| ND-GAIN Country Index | Free CSV download |
| Flood risk at supplier lat/long | Four Twenty Seven / Jupiter (paid); proxy: ND-GAIN |
| Drought / water stress index | NOAA, ND-GAIN |
| Cyclone / extreme weather exposure | NOAA historical tracks |

**Model:** Weighted sum of standardized dimension scores (z-scored within each dimension before aggregation). Default weights: 30% / 25% / 25% / 20%. User-configurable. No training required — this is a deterministic scoring model, not a learned one. Calibration: anchor against known high-risk events (supplier failures, country-level export bans) to validate score cutoffs.

### Output
```
{
  "supplier_id": "SUP-022",
  "supplier_name": "Agro Exports Ltd.",
  "risk_score": 74,
  "rag_status": "RED",
  "top_driver": "geopolitical",
  "dimensions": {
    "concentration": 55,
    "financial": 40,
    "geopolitical": 88,
    "climate": 62
  },
  "concentration_ratio": 0.34,
  "country_risk_score": 81,
  "last_updated": "2026-10-01"
}
```

---

## ML-09 — Composite Shipment Risk Score & Forecast Signal

**Source feature:** F-SHIP-006  
**Type:** Ensemble aggregation + threshold rule

### Objective
Integrate outputs from ML-05 (delay), ML-06 (corridor threat), ML-07 (vessel risk), and ML-08 (supplier risk) plus sanctions compliance status into a single per-lane risk score. Output a `forecast_signal` that tells the demand planning model how many days of safety stock cover to add or reduce.

### Inputs (all from upstream ML models)
| Input | Source model |
|---|---|
| `delay_probability` | ML-05 |
| `corridor_threat_level` | ML-06 |
| `compliance_status` | F-SHIP-003 (0=clean, 50=flagged, 100=blocked) |
| `carrier_reliability_inv` | F-SHIP-004 (1 − carrier score, so higher = riskier) |
| `supplier_risk_score` | ML-08 |

### Model
Weighted average of normalized inputs. Compliance overrides: `compliance_status = 100` forces final score to 100.

```
Score = w1×delay_prob + w2×corridor_threat + w3×carrier_risk + w4×supplier_risk
```
Default weights: 30% / 25% / 25% / 20%.

**Forecast signal rules (deterministic):**
- Score >70 and rising (7-day trend) → `ADD_COVER: +7 days`
- Score >70, stable → `ADD_COVER: +3 days`
- Score 40–70 → `MONITOR`
- Score <40 and falling → `REDUCE_COVER: −2 days`

### Output
```
{
  "lane": "IN-MUMBAI → NL-ROTTERDAM",
  "lane_risk_score": 77,
  "rag_status": "RED",
  "risk_trend": "deteriorating",
  "top_driver": "corridor_threat",
  "forecast_signal": {
    "action": "ADD_COVER",
    "days_to_add": 7,
    "reason": "Red Sea threat level 4 + MSC reliability 62%"
  },
  "component_scores": {
    "delay_probability": 0.71,
    "corridor_threat": 4,
    "compliance": 0,
    "carrier_reliability_inv": 0.38,
    "supplier_risk": 74
  }
}
```

---

## Summary Table

| ID | Name | Type | Key Data | FR Source |
|---|---|---|---|---|
| ML-01 | Commodity Price Forecast | Ridge + futures nowcast (v1 built; validated 1–3M) | Pink Sheet monthly prices 1980+, daily front-month futures | F-PRICE-020a |
| ML-02 | Seasonal Decomposition | STL decomposition | 2Y weekly price history | F-PRICE-022 |
| ML-03 | Pass-Through Rate | Rolling OLS regression | Net realized price + input cost index | F-PRICE-017 |
| ML-04 | Leading Indicators Panel | Cross-correlation + Granger causality | 5Y price + indicators (futures, weather, freight) | F-PRICE-021 |
| ML-05 | Predictive Delay Scoring | XGBoost / LightGBM classifier | 200+ historical shipments per lane, AIS, weather, carrier data | F-SHIP-001 |
| ML-06 | Corridor Threat Scoring | Weighted rule-based scoring | ACLED events, UKMTO advisories, historical incidents | F-SHIP-002 |
| ML-07 | Vessel Behavioural Risk | Anomaly detection + rule flags | AIS history, vessel registry, OFAC positives | F-SHIP-003b |
| ML-08 | Supply Chain Risk Scoring | Composite weighted scoring | User procurement data, World Bank WGI, ACLED, ND-GAIN, D&B | F-SHIP-005 |
| ML-09 | Composite Shipment Risk + Forecast Signal | Ensemble aggregation + threshold rules | Outputs of ML-05 through ML-08 | F-SHIP-006 |

---

## Data Availability vs. Model Readiness

| Model | Free data sufficient to build MVP? | Blocker for full production |
|---|---|---|
| ML-01 | Yes — World Bank + NOAA + USDA NASS | Paid futures data (MCX/CME) for term structure |
| ML-02 | Yes — World Bank history | None for public commodities; user data needed for FMCG SKUs |
| ML-03 | No — needs user ERP data | User must supply net realized price + BOM |
| ML-04 | Mostly — World Bank + NOAA + Freightos public index | Paid futures for high-quality lead signal |
| ML-05 | No — needs user historical shipments + paid AIS | Min 200 shipment actuals per lane; AIS subscription |
| ML-06 | Yes — ACLED + UKMTO free | Lloyd's List Intelligence improves accuracy |
| ML-07 | No — needs AIS history | AIS subscription (Spire / MarineTraffic) |
| ML-08 | Partial — World Bank WGI + ACLED + ND-GAIN free; financial health requires D&B | D&B or Moody's for supplier financial dimension |
| ML-09 | Depends on upstream models | All upstream models must produce scores |

---

## Build Order (Recommended)

1. **ML-02** — Seasonal decomposition. Pure calculation, no external data beyond what we already have. Quick win.
2. **ML-01** — Price forecast. Core product value. Starts with free data; futures improves it later.
3. **ML-04** — Leading indicators. Uses same data as ML-01; adds interpretability.
4. **ML-06** — Corridor threat. Free data (ACLED + UKMTO); directly improves the chokepoint panel already in the UI.
5. **ML-08** — Supply chain risk scoring. Free geopolitical + climate data available now; financial dimension added later.
6. **ML-09** — Composite risk + forecast signal. Wires up as soon as upstream scores exist.
7. **ML-03** — Pass-through rate. Needs user ERP data; build the connector first.
8. **ML-05** — Delay scoring. Needs AIS subscription + user historical shipments; highest value once data exists.
9. **ML-07** — Vessel risk. Needs AIS history; pairs with ML-05.
