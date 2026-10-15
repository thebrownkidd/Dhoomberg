// Types shared by the browser (src/) and the local server (server/).

export type Bar = { date: string; open?: number; high?: number; low?: number; close: number; volume?: number };
export type Quote = { price: number; ts: string; source: string };

// ── Plugins ──────────────────────────────────────────────────────────────────
export type PluginKind = 'datasource' | 'news' | 'model' | 'action' | 'broker' | 'indicator';

export type JSONSchema = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  title?: string;
  description?: string;
  default?: unknown;
  enum?: (string | number)[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  minimum?: number;
  maximum?: number;
  format?: 'uri' | 'password' | 'textarea' | 'json';
  'x-secret'?: boolean;
  'x-placeholder'?: string;
};

export type PluginManifest = {
  id: string;
  kind: PluginKind;
  name: string;
  category: string;
  description: string;
  docsUrl?: string;
  configSchema: JSONSchema;
  capabilities?: {
    realtime?: boolean;    // quotes carry a real timestamp (required for live orders)
    llm?: boolean;         // model plugin that answers prompts
    forecast?: boolean;    // model plugin that returns a forecast
    live?: boolean;        // broker can trade real money
    symbolHint?: string;   // example symbol shown in the UI
  };
  source: 'builtin' | 'python';
};

export type Connection = {
  id: string;
  pluginId: string;
  name: string;
  config: Record<string, unknown>;            // secrets replaced by masks
  secrets: Record<string, string>;            // field -> mask, e.g. "●●●●1a2b"
  enabled: boolean;
  createdAt: string;
  lastTest?: { ok: boolean; message: string; at: string } | null;
};

// ── Instruments ──────────────────────────────────────────────────────────────
export type Instrument = {
  id: string;
  name: string;
  code: string;
  unit: string;
  dp: number;
  multiplier: number;        // contract multiplier for notional (1 for spot / shares)
  connectionId: string;      // 'demo' for the built-in mock source
  symbol: string;
  custom: boolean;
};

// ── News ─────────────────────────────────────────────────────────────────────
export type NewsItem = {
  id: string;
  headline: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
  commodities: string[];
  sentiment: 'bullish' | 'bearish' | 'neutral' | null;
  sentimentScore: number | null;
  tags: string[];
};

// ── Forecasts ────────────────────────────────────────────────────────────────
export type ForecastPoint = { date: string; p10: number | null; p50: number; p90: number | null };
export type ForecastResult = {
  model: string;
  forecast: ForecastPoint[];
  baseline: ForecastPoint[];           // naive forecast, always shown alongside
  evaluation: {
    origins: number;                   // rolling-origin backtest count
    horizon: number;
    mae: number;
    naiveMae: number;
    skill: number;                     // 1 - mae / naiveMae ; > 0 beats naive
  } | null;
  note?: string;
};

export type LlmView = { bias: 'bullish' | 'bearish' | 'neutral'; confidence: number; rationale: string; model: string; at: string };

// ── Rules ────────────────────────────────────────────────────────────────────
export type Operand =
  | { type: 'const'; value: number }
  | { type: 'price'; instrument: string }
  | { type: 'indicator'; instrument: string; indicator: string; params: Record<string, number | string>; output?: string }
  | { type: 'model'; instrument: string; model: string; horizon: number }            // expected % change at horizon
  | { type: 'news'; instrument: string; field: 'sentiment_avg' | 'bullish_count' | 'bearish_count'; windowHours: number }
  | { type: 'llm'; instrument: string; connectionId: string }                        // bias score in [-1, 1]
  | { type: 'demand'; series: string }                                               // latest value of a demand.json series
  | { type: 'cot'; instrument: string };                                             // managed-money net long % OI

export type Operator = '>' | '<' | '>=' | '<=' | 'crosses_above' | 'crosses_below' | 'pct_change_gt' | 'pct_change_lt' | 'between';

export type Condition = { kind: 'cond'; left: Operand; op: Operator; right: Operand; upper?: number; lookback?: number };
export type Group = { kind: 'group'; mode: 'all' | 'any'; items: (Condition | Group)[] };

export type RuleAction =
  | { type: 'notify'; connectionId: string }
  | {
      type: 'order';
      connectionId: string;          // broker connection
      instrument: string;
      symbol?: string;               // broker's symbol if it differs from the data source's (e.g. CLZ6, an IBKR conid)
      side: 'buy' | 'sell';
      qty?: number;
      notional?: number;
      orderType: 'market' | 'limit';
      limitOffsetPct?: number;       // limit = last * (1 ± offset)
      tif: 'day' | 'gtc' | 'ioc';
    };

export type ExecMode = 'notify' | 'confirm' | 'auto';

export type Rule = {
  id: string;
  name: string;
  enabled: boolean;
  when: Group;
  cadence: { type: 'tick' } | { type: 'interval'; minutes: number } | { type: 'bar' };
  cooldownMin: number;
  activeHours?: { tz: string; start: string; end: string; days: number[] } | null;
  mode: ExecMode;
  actions: RuleAction[];
  createdAt: string;
  updatedAt: string;
};

export type BacktestResult = {
  ruleId: string;
  instrument: string;
  bars: number;
  fires: { date: string; price: number }[];
  skippedConditions: string[];        // operands without history (news, LLM, …)
  forwardReturn: {
    horizonBars: number;
    direction: 'long' | 'short';
    n: number;
    avg: number | null;              // mean forward return after a fire, in the trade direction, %
    hitRate: number | null;          // share of fires with a positive directional return
    baselineAvg: number | null;      // mean forward return over all bars (what "always in" earns), %
    firstHalfAvg: number | null;     // stability check: fires in the first vs second half of history
    secondHalfAvg: number | null;
  };
  note: string;
};

// ── Orders ───────────────────────────────────────────────────────────────────
export type OrderIntent = {
  connectionId: string;
  instrument: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  orderType: 'market' | 'limit';
  limitPrice?: number;
  tif: 'day' | 'gtc' | 'ioc';
  ruleId?: string;
  idemKey: string;
};

export type OrderStatus = 'pending_approval' | 'rejected' | 'submitted' | 'open' | 'filled' | 'cancelled' | 'error' | 'needs_confirmation';

export type OrderRecord = OrderIntent & {
  id: string;
  mode: 'paper' | 'live';
  status: OrderStatus;
  notional: number;
  refPrice: number;
  fillPrice: number | null;
  brokerOrderId: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Approval = {
  id: string;
  ruleId: string | null;
  ruleName: string;
  intent: OrderIntent;
  refPrice: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  decidedAt: string | null;
  result: string | null;
};

export type RiskLimits = {
  maxOrderNotional: number;
  maxDailyNotional: number;
  maxOrdersPerDay: number;
  maxPositionNotional: number;
  maxLimitDeviationPct: number;
  maxQuoteAgeSec: number;
  approvalTtlMin: number;
};

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxOrderNotional: 10_000,
  maxDailyNotional: 50_000,
  maxOrdersPerDay: 20,
  maxPositionNotional: 25_000,
  maxLimitDeviationPct: 2,
  maxQuoteAgeSec: 300,
  approvalTtlMin: 15,
};

export type Position = { instrument: string; symbol: string; qty: number; avgPrice: number; marketPrice: number | null; unrealizedPnl: number | null };
export type Account = { equity: number | null; cash: number | null; currency: string };

export type AuditEntry = { id: number; ts: string; kind: string; ruleId: string | null; ref: string | null; detail: Record<string, unknown> };

export type ServerEvent =
  | { type: 'audit'; entry: AuditEntry }
  | { type: 'halt'; halted: boolean }
  | { type: 'approvals' }
  | { type: 'orders' }
  | { type: 'connections' }
  | { type: 'plugins' };

export type HealthInfo = {
  ok: true;
  version: string;
  halted: boolean;
  python: { available: boolean; plugins: number; error: string | null };
  connections: { id: string; name: string; pluginId: string; kind: PluginKind; enabled: boolean; ok: boolean | null; live: boolean }[];
};
