export type Commodity = {
  id: string;
  code: string;
  name: string;
  unit: string;
  base: number;
  vol: number;
  dp: number;
};

export type Bar = { date: string; close: number };

export type Threat = 1 | 2 | 3 | 4 | 5;

export type Chokepoint = {
  id: string;
  name: string;
  risk: string;
  threat: Threat;
  transitNow: number;
  transitAvg: number;
  vesselsDay: number;
  vesselsAvg: number;
  queue: number;
  rerouteVia: string | null;
  rerouteUsdTeu: number | null;
  rerouteDays: number | null;
  lastIncident: string;
};

export type RiskAlert = {
  id: string;
  commodity: string;
  lane: string;
  score: number;
  trend: 'up' | 'flat' | 'down';
  driver: string;
  signal: string;
};

export type NewsTag = 'PRICE' | 'SHIP' | 'RISK' | 'SANC' | 'MACRO';
export type NewsItem = { id: string; minutesAgo: number; tag: NewsTag; headline: string };

export const COMMODITIES: Commodity[] = [
  // Energy
  { id: 'BRENT',      code: 'CO',    name: 'Brent Crude',         unit: '$/bbl',     base: 74,    vol: 0.018, dp: 2 },
  { id: 'WTI',        code: 'WTI',   name: 'Crude Oil WTI',       unit: '$/bbl',     base: 72,    vol: 0.018, dp: 2 },
  { id: 'DUBAI',      code: 'DU',    name: 'Crude Oil Dubai',     unit: '$/bbl',     base: 70,    vol: 0.017, dp: 2 },
  { id: 'COAL_AU',    code: 'XQ',    name: 'Coal Australian',     unit: '$/mt',      base: 135,   vol: 0.012, dp: 0 },
  { id: 'NATGAS_US',  code: 'NG',    name: 'Natural Gas US',      unit: '$/mmbtu',   base: 2.50,  vol: 0.030, dp: 2 },
  { id: 'NATGAS_EU',  code: 'TTF',   name: 'Natural Gas EU',      unit: '$/mmbtu',   base: 11.0,  vol: 0.025, dp: 2 },
  // Vegetable oils & oilseeds
  { id: 'PALM',       code: 'FCPO',  name: 'Palm Oil',            unit: '$/mt',      base: 855,   vol: 0.016, dp: 0 },
  { id: 'SOYOIL',     code: 'ZL',    name: 'Soybean Oil',         unit: '$/mt',      base: 975,   vol: 0.017, dp: 0 },
  { id: 'SOYBEANS',   code: 'ZS',    name: 'Soybeans',            unit: '$/mt',      base: 380,   vol: 0.014, dp: 0 },
  { id: 'SOYMEAL',    code: 'ZM',    name: 'Soybean Meal',        unit: '$/mt',      base: 325,   vol: 0.015, dp: 0 },
  { id: 'COCONUT',    code: 'CNOIL', name: 'Coconut Oil',         unit: '$/mt',      base: 1050,  vol: 0.015, dp: 0 },
  { id: 'GNUT_OIL',   code: 'GNO',   name: 'Groundnut Oil',       unit: '$/mt',      base: 1450,  vol: 0.013, dp: 0 },
  // Grains
  { id: 'WHEAT',      code: 'KE',    name: 'Wheat HRW',           unit: '$/mt',      base: 215,   vol: 0.017, dp: 0 },
  { id: 'WHEAT_SRW',  code: 'ZW',    name: 'Wheat SRW',           unit: '$/mt',      base: 210,   vol: 0.017, dp: 0 },
  { id: 'MAIZE',      code: 'ZC',    name: 'Maize',               unit: '$/mt',      base: 175,   vol: 0.015, dp: 0 },
  { id: 'RICE',       code: 'ZR',    name: 'Rice Thai 5%',        unit: '$/mt',      base: 445,   vol: 0.011, dp: 0 },
  // Softs
  { id: 'SUGAR',      code: 'SB',    name: 'Sugar World',         unit: '$/kg',      base: 0.42,  vol: 0.018, dp: 3 },
  { id: 'SUGAR_US',   code: 'SUS',   name: 'Sugar US',            unit: '$/kg',      base: 0.68,  vol: 0.012, dp: 3 },
  { id: 'COCOA',      code: 'CC',    name: 'Cocoa',               unit: '$/kg',      base: 9.50,  vol: 0.026, dp: 2 },
  { id: 'COFFEE',     code: 'KC',    name: 'Coffee Arabica',      unit: '$/kg',      base: 3.80,  vol: 0.021, dp: 2 },
  { id: 'COFFEE_ROB', code: 'RC',    name: 'Coffee Robusta',      unit: '$/kg',      base: 3.50,  vol: 0.022, dp: 2 },
  { id: 'COTTON',     code: 'CT',    name: 'Cotton A Index',      unit: '$/kg',      base: 1.68,  vol: 0.014, dp: 3 },
  { id: 'RUBBER',     code: 'RSS3',  name: 'Rubber RSS3',         unit: '$/kg',      base: 1.65,  vol: 0.018, dp: 3 },
  // Livestock & protein
  { id: 'BEEF',       code: 'BEEF',  name: 'Beef',                unit: '$/kg',      base: 4.80,  vol: 0.010, dp: 2 },
  { id: 'CHICKEN',    code: 'CHKN',  name: 'Chicken',             unit: '$/kg',      base: 2.20,  vol: 0.009, dp: 2 },
  { id: 'FISHMEAL',   code: 'FISH',  name: 'Fish Meal',           unit: '$/mt',      base: 1450,  vol: 0.012, dp: 0 },
  // Fertilizers
  { id: 'DAP',        code: 'DAP',   name: 'DAP',                 unit: '$/mt',      base: 565,   vol: 0.012, dp: 0 },
  { id: 'TSP',        code: 'TSP',   name: 'TSP',                 unit: '$/mt',      base: 395,   vol: 0.011, dp: 0 },
  { id: 'UREA',       code: 'UREA',  name: 'Urea',                unit: '$/mt',      base: 285,   vol: 0.013, dp: 0 },
  { id: 'POTASH',     code: 'MOP',   name: 'Potassium Chloride',  unit: '$/mt',      base: 280,   vol: 0.010, dp: 0 },
  { id: 'PHOSPHATE',  code: 'PHOS',  name: 'Phosphate Rock',      unit: '$/mt',      base: 190,   vol: 0.009, dp: 0 },
  // Base metals
  { id: 'ALU',        code: 'LA',    name: 'Aluminium',           unit: '$/mt',      base: 2450,  vol: 0.012, dp: 0 },
  { id: 'COPPER',     code: 'HG',    name: 'Copper',              unit: '$/mt',      base: 9200,  vol: 0.014, dp: 0 },
  { id: 'NICKEL',     code: 'NI',    name: 'Nickel',              unit: '$/mt',      base: 16500, vol: 0.018, dp: 0 },
  { id: 'ZINC',       code: 'ZN',    name: 'Zinc',                unit: '$/mt',      base: 2800,  vol: 0.014, dp: 0 },
  { id: 'LEAD',       code: 'PB',    name: 'Lead',                unit: '$/mt',      base: 2050,  vol: 0.012, dp: 0 },
  { id: 'TIN',        code: 'SN',    name: 'Tin',                 unit: '$/mt',      base: 30000, vol: 0.014, dp: 0 },
  { id: 'IRON',       code: 'IO',    name: 'Iron Ore',            unit: '$/dmtu',    base: 105,   vol: 0.016, dp: 2 },
  // Precious metals
  { id: 'GOLD',       code: 'GC',    name: 'Gold',                unit: '$/troy oz', base: 2650,  vol: 0.010, dp: 2 },
  { id: 'SILVER',     code: 'SI',    name: 'Silver',              unit: '$/troy oz', base: 31.0,  vol: 0.018, dp: 2 },
  { id: 'PLATINUM',   code: 'PL',    name: 'Platinum',            unit: '$/troy oz', base: 960,   vol: 0.013, dp: 2 },
  // Other agricultural
  { id: 'BANANA',     code: 'BAN',   name: 'Banana',              unit: '$/kg',      base: 0.96,  vol: 0.010, dp: 3 },
  { id: 'ORANGE',     code: 'OJ',    name: 'Orange',              unit: '$/kg',      base: 0.88,  vol: 0.012, dp: 3 },
  { id: 'TEA',        code: 'TEA',   name: 'Tea',                 unit: '$/kg',      base: 2.55,  vol: 0.010, dp: 2 },
  { id: 'TOBACCO',    code: 'TOB',   name: 'Tobacco',             unit: '$/mt',      base: 4300,  vol: 0.008, dp: 0 },
  { id: 'TIMBER_MY',  code: 'LOG',   name: 'Logs Malaysian',      unit: '$/m³', base: 245,   vol: 0.009, dp: 0 },
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r: () => number): number {
  const u = 1 - r();
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function roundTo(x: number, dp: number): number {
  return Number(x.toFixed(dp));
}

function isoLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

const TRADING_DAYS = 1300;
const historyCache = new Map<string, Bar[]>();

// Mean-reverting log random walk with a yearly seasonal drift, seeded per commodity.
export function history(id: string): Bar[] {
  const cached = historyCache.get(id);
  if (cached) return cached;
  const c = COMMODITIES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown commodity: ${id}`);

  const dates: Date[] = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (dates.length < TRADING_DAYS) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) dates.unshift(new Date(d));
    d.setDate(d.getDate() - 1);
  }

  const r = seeded(hashStr(c.id));
  const logBase = Math.log(c.base);
  const phase = r() * Math.PI * 2;
  let x = logBase + gauss(r) * 0.15;
  const bars = dates.map((dt, i) => {
    const seasonal = 0.0015 * Math.sin((2 * Math.PI * i) / 260 + phase);
    x += 0.004 * (logBase - x) + c.vol * gauss(r) + seasonal;
    return { date: isoLocal(dt), close: roundTo(Math.exp(x), c.dp) };
  });
  historyCache.set(id, bars);
  return bars;
}

export const CHOKEPOINTS: Chokepoint[] = [
  {
    id: 'SUEZ', name: 'Suez Canal', risk: 'Diversions, reduced northbound traffic', threat: 3,
    transitNow: 14.5, transitAvg: 12.0, vesselsDay: 38, vesselsAvg: 52, queue: 9,
    rerouteVia: 'Cape of Good Hope', rerouteUsdTeu: 1050, rerouteDays: 12,
    lastIncident: 'Convoy schedule extended, southbound wait +6h',
  },
  {
    id: 'PANAMA', name: 'Panama Canal', risk: 'Gatun Lake draught limits', threat: 2,
    transitNow: 11.2, transitAvg: 10.0, vesselsDay: 32, vesselsAvg: 36, queue: 21,
    rerouteVia: 'Suez / US land bridge', rerouteUsdTeu: 620, rerouteDays: 7,
    lastIncident: 'Neopanamax max draught held at 14.6m',
  },
  {
    id: 'BAB', name: 'Red Sea / Bab el-Mandeb', risk: 'Armed attacks on merchant vessels', threat: 5,
    transitNow: 9.0, transitAvg: 8.0, vesselsDay: 24, vesselsAvg: 70, queue: 0,
    rerouteVia: 'Cape of Good Hope', rerouteUsdTeu: 1150, rerouteDays: 14,
    lastIncident: 'UKMTO advisory: suspicious approach 40nm W of Hodeidah',
  },
  {
    id: 'HORMUZ', name: 'Strait of Hormuz', risk: 'Military tension, vessel seizures', threat: 4,
    transitNow: 6.5, transitAvg: 6.0, vesselsDay: 110, vesselsAvg: 118, queue: 4,
    rerouteVia: null, rerouteUsdTeu: null, rerouteDays: null,
    lastIncident: 'Naval exercise notice, eastbound lane narrowed',
  },
  {
    id: 'MALACCA', name: 'Strait of Malacca', risk: 'Congestion, petty piracy', threat: 2,
    transitNow: 22.0, transitAvg: 18.0, vesselsDay: 230, vesselsAvg: 215, queue: 31,
    rerouteVia: 'Lombok / Sunda', rerouteUsdTeu: 180, rerouteDays: 3,
    lastIncident: 'Port Klang anchorage wait 2.4 days',
  },
  {
    id: 'BOSPH', name: 'Bosphorus', risk: 'Seasonal fog, transit restrictions', threat: 1,
    transitNow: 13.0, transitAvg: 12.5, vesselsDay: 115, vesselsAvg: 120, queue: 18,
    rerouteVia: null, rerouteUsdTeu: null, rerouteDays: null,
    lastIncident: 'Night transits suspended for 1 day (fog)',
  },
  {
    id: 'CAPE', name: 'Cape of Good Hope', risk: 'Winter swell, bunkering capacity', threat: 2,
    transitNow: 0, transitAvg: 0, vesselsDay: 92, vesselsAvg: 61, queue: 0,
    rerouteVia: null, rerouteUsdTeu: null, rerouteDays: null,
    lastIncident: 'Algoa Bay bunker queue at 3 vessels',
  },
];

export const RISK_ALERTS: RiskAlert[] = [
  { id: 'R1', commodity: 'Cocoa', lane: 'Abidjan → Rotterdam', score: 84, trend: 'up', driver: 'Supplier concentration: CIV 62% of volume', signal: '+10d cover' },
  { id: 'R2', commodity: 'Palm Oil', lane: 'Port Klang → Nhava Sheva', score: 78, trend: 'up', driver: 'Malacca congestion, queue 31', signal: '+6d cover' },
  { id: 'R3', commodity: 'Wheat', lane: 'Novorossiysk → Alexandria', score: 72, trend: 'up', driver: 'Vessel flag change in last 90 days', signal: 'Compliance review' },
  { id: 'R4', commodity: 'Brent', lane: 'Ras Tanura → Jamnagar', score: 66, trend: 'up', driver: 'Hormuz threat level 4', signal: '+4d cover' },
  { id: 'R5', commodity: 'Sugar', lane: 'Santos → Kandla', score: 61, trend: 'flat', driver: 'Carrier reliability 58%', signal: '+3d cover' },
  { id: 'R6', commodity: 'Coffee', lane: 'Santos → Hamburg', score: 48, trend: 'flat', driver: 'Frost risk, Minas Gerais', signal: 'Monitor' },
  { id: 'R7', commodity: 'Skim Milk Powder', lane: 'Auckland → Singapore', score: 32, trend: 'down', driver: 'Stable lane, carrier on time 91%', signal: '−2d cover' },
];

export const NEWS: NewsItem[] = [
  { id: 'N1', minutesAgo: 2, tag: 'SHIP', headline: 'Port Klang anchorage queue climbs to 31 vessels; berth wait at 2.4 days' },
  { id: 'N2', minutesAgo: 9, tag: 'PRICE', headline: 'Cocoa extends gains as mid-crop arrivals run 18% below last season' },
  { id: 'N3', minutesAgo: 17, tag: 'SANC', headline: 'Consolidated sanctions list update adds 14 vessels and 3 ship managers' },
  { id: 'N4', minutesAgo: 26, tag: 'RISK', headline: 'Red Sea advisory remains at highest level; carriers keep Cape routing' },
  { id: 'N5', minutesAgo: 41, tag: 'PRICE', headline: 'Palm oil steadies after export levy cut; stockpiles seen at 1.9 Mt' },
  { id: 'N6', minutesAgo: 58, tag: 'MACRO', headline: 'Rupee weakens past 85.4 per dollar, lifting landed cost of imports' },
  { id: 'N7', minutesAgo: 73, tag: 'SHIP', headline: 'Panama Canal keeps 14.6m draught limit for neopanamax transits' },
  { id: 'N8', minutesAgo: 95, tag: 'PRICE', headline: 'Sugar slips as cane crush in centre-south outpaces estimates' },
  { id: 'N9', minutesAgo: 120, tag: 'RISK', headline: 'Monsoon deficit widens to 11% in key kharif states' },
  { id: 'N10', minutesAgo: 150, tag: 'MACRO', headline: 'Container spot index flat week on week on Asia–Europe lane' },
];
