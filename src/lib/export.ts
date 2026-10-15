/** CSV / JSON download utilities. No server, no dependencies beyond the browser. */
import type { Bar, ForecastPoint } from '../data/api';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toCSV(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (c.includes(',') || c.includes('"') || c.includes('\n') ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}

export function exportHistoryCSV(id: string, history: Bar[]) {
  const rows: string[][] = [['date', 'close']];
  for (const b of history) rows.push([b.date, String(b.close)]);
  downloadBlob(new Blob([toCSV(rows)], { type: 'text/csv' }), `${id}_history.csv`);
}

export function exportForecastCSV(id: string, forecast: ForecastPoint[]) {
  const rows: string[][] = [['date', 'p10', 'p50', 'p90']];
  for (const f of forecast) rows.push([f.date, String(f.p10), String(f.p50), String(f.p90)]);
  downloadBlob(new Blob([toCSV(rows)], { type: 'text/csv' }), `${id}_forecast.csv`);
}

export function exportAllCSV(id: string, history: Bar[], forecast: ForecastPoint[]) {
  const rows: string[][] = [['date', 'type', 'close', 'p10', 'p50', 'p90']];
  for (const b of history) rows.push([b.date, 'history', String(b.close), '', '', '']);
  for (const f of forecast) rows.push([f.date, 'forecast', '', String(f.p10), String(f.p50), String(f.p90)]);
  downloadBlob(new Blob([toCSV(rows)], { type: 'text/csv' }), `${id}_all.csv`);
}

export function exportJSON(id: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `${id}.json`);
}
