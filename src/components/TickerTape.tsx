import type { LiveQuote } from '../App';
import { dirClass, fmt, pct } from './format';

export default function TickerTape({ quotes }: { quotes: LiveQuote[] }) {
  const items = quotes.map((q) => {
    const ch = q.last / q.prevClose - 1;
    return (
      <span key={q.id} className="tape-item">
        <span className="tape-code">{q.code}</span>
        <span>{fmt(q.last, q.dp)}</span>
        <span className={dirClass(ch)}>
          {ch > 0 ? '▲' : ch < 0 ? '▼' : '■'} {pct(ch)}
        </span>
      </span>
    );
  });
  return (
    <div className="tape" aria-label="Commodity ticker">
      <div className="tape-track">
        <div className="tape-run">{items}</div>
        <div className="tape-run" aria-hidden="true">{items}</div>
      </div>
    </div>
  );
}
