import { describe, expect, it } from 'vitest';
import { pluck, render, toIso, num } from '../server/http';
import { extractRows, rowsToBars } from '../server/plugins/datasources';
import { renderJsonTemplate, oauth1Header } from '../server/plugins/actions';
import { lexiconScore, tagCommodities, label } from '../server/plugins/news';

describe('field mapping', () => {
  it('pluck handles dots, indices and bracketed keys', () => {
    const o = { a: { b: [{ c: 1 }] }, 'Time Series (Daily)': { x: 2 }, arr: [[0, 7]] };
    expect(pluck(o, 'a.b[0].c')).toBe(1);
    expect(pluck(o, '["Time Series (Daily)"].x')).toBe(2);
    expect(pluck(o.arr[0], '[1]')).toBe(7);
    expect(pluck(o, '')).toBe(o);
  });
  it('dates: ISO, epoch s/ms/ns, compact, year-month', () => {
    expect(toIso('2026-10-13')).toBe('2026-10-13');
    expect(toIso(1760313600)).toBe('2025-10-13');
    expect(toIso(1760313600000)).toBe('2025-10-13');
    expect(toIso('1760313600000000000')).toBe('2025-10-13');
    expect(toIso('20261013T153000', false)).toBe('2026-10-13T15:30:00.000Z');
    expect(toIso('2026-09')).toBe('2026-09');
    expect(toIso('not a date')).toBeNull();
  });
  it('numbers: commas, FRED "." and blanks', () => {
    expect(num('1,234.5')).toBe(1234.5);
    expect(Number.isNaN(num('.'))).toBe(true);
    expect(Number.isNaN(num(''))).toBe(true);
  });
  it('URL templates are encoded', () => expect(render('/x?s={symbol}', { symbol: 'CL=F' }, 'url')).toBe('/x?s=CL%3DF'));
});

describe('response shapes from real APIs', () => {
  it('Alpha Vantage: object keyed by date', () => {
    const body = { 'Time Series (Daily)': { '2026-10-10': { '4. close': '70.1' }, '2026-10-09': { '4. close': '69.5' } } };
    const bars = rowsToBars(extractRows(body, { rowsPath: '["Time Series (Daily)"]' }), { dateField: '$key', closeField: '["4. close"]' });
    expect(bars).toEqual([{ date: '2026-10-09', close: 69.5 }, { date: '2026-10-10', close: 70.1 }]);
  });
  it('FRED: drops "." missing values', () => {
    const body = { observations: [{ date: '2026-10-01', value: '.' }, { date: '2026-10-02', value: '71.2' }] };
    expect(rowsToBars(extractRows(body, { rowsPath: 'observations' }), { dateField: 'date', closeField: 'value' })).toHaveLength(1);
  });
  it('Yahoo: columnar arrays', () => {
    const body = { chart: { result: [{ timestamp: [1760313600, 1760400000], indicators: { quote: [{ close: [60.1, null] }] } }] } };
    const rows = extractRows(body, { columnar: true, dateField: 'chart.result[0].timestamp', closeField: 'chart.result[0].indicators.quote[0].close' });
    expect(rowsToBars(rows, { dateField: 'date', closeField: 'close' })).toEqual([{ date: '2025-10-13', close: 60.1 }]);
  });
  it('Binance: arrays of arrays, string prices', () => {
    const rows = extractRows([[1760313600000, '1', '2', '0.5', '1.5', '100']], { rowsPath: '' });
    expect(rowsToBars(rows, { dateField: '[0]', closeField: '[4]', highField: '[2]' })[0]).toMatchObject({ date: '2025-10-13', close: 1.5, high: 2 });
  });
  it('Databento: fixed-point scale', () => {
    expect(rowsToBars([{ hd: { ts_event: '1760313600000000000' }, close: '70120000000' }], { dateField: 'hd.ts_event', closeField: 'close', scale: 1e-9 })[0].close).toBeCloseTo(70.12, 9);
  });
  it('a wrong rows path explains itself', () => expect(() => extractRows({ a: 1 }, { rowsPath: 'data' })).toThrow(/did not resolve/));
});

describe('action templates', () => {
  const msg = { title: 'He said "buy"', body: 'line1\nline2', severity: 'info' as const, data: { price: 1.5, instrument: 'SUGAR' } };
  it('escapes quoted placeholders and embeds {{data}} as JSON', () => {
    const out = JSON.parse(renderJsonTemplate('{"t": "{{title}}", "b": "{{body}}", "p": "{{price}}", "d": {{data}}}', msg));
    expect(out).toEqual({ t: 'He said "buy"', b: 'line1\nline2', p: '1.5', d: { price: 1.5, instrument: 'SUGAR' } });
  });
  it('rejects templates that do not render to JSON', () => expect(() => renderJsonTemplate('{"t": {{title}}}', msg)).toThrow(/not valid JSON/));
  it('OAuth 1.0a header is deterministic and well-formed', () => {
    const c = { realm: '123_SB1', consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'tk', tokenSecret: 'ts' };
    const a = oauth1Header('POST', 'https://x.suitetalk.api.netsuite.com/services/rest/record/v1/customer?q=1', c, 'nonce', '1700000000');
    const b = oauth1Header('POST', 'https://x.suitetalk.api.netsuite.com/services/rest/record/v1/customer?q=1', c, 'nonce', '1700000000');
    expect(a).toBe(b);
    expect(a).toMatch(/^OAuth realm="123_SB1", oauth_consumer_key="ck", .*oauth_signature_method="HMAC-SHA256".*oauth_signature="[A-Za-z0-9%]+"$/);
    expect(a).not.toContain('q=');
  });
});

describe('news tagging', () => {
  it('tags commodities on word boundaries', () => {
    expect(tagCommodities('Cocoa futures surge as Ivory Coast arrivals lag')).toEqual(['COCOA']);
    expect(tagCommodities('Platinum demand')).toEqual(['PLATINUM']);
    expect(tagCommodities('Corner store sales')).toEqual([]);
  });
  it('lexicon is null without hits and labels by threshold', () => {
    expect(lexiconScore('Ministry publishes schedule')).toBeNull();
    expect(label(lexiconScore('Copper prices plunge on demand fears'))).toBe('bearish');
    expect(label(lexiconScore('Wheat rallies on shortage'))).toBe('bullish');
  });
});
