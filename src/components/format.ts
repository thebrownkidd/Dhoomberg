export function fmt(n: number, dp: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function signed(n: number, dp: number): string {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n), dp)}`;
}

export function pct(n: number): string {
  return `${signed(n * 100, 2)}%`;
}

export function dirClass(n: number): string {
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}
