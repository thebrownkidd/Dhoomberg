import type { LiveQuote } from '../App';
import { dirClass, fmt, pct, signed } from './format';

type Props = {
  quotes: LiveQuote[];
  selected: string;
  onSelect: (id: string) => void;
};

export default function Watchlist({ quotes, selected, onSelect }: Props) {
  return (
    <table className="t">
      <thead>
        <tr>
          <th className="l">Ticker</th>
          <th>Last</th>
          <th>Chg</th>
          <th>%Chg</th>
          <th>52W</th>
        </tr>
      </thead>
      <tbody>
        {quotes.map((q) => {
          const ch = q.last - q.prevClose;
          const pos = q.high52 > q.low52 ? (q.last - q.low52) / (q.high52 - q.low52) : 0.5;
          return (
            <tr
              key={q.id}
              className={q.id === selected ? 'sel' : undefined}
              onClick={() => onSelect(q.id)}
              title={`${q.name} · ${q.unit}`}
            >
              <td className="l">
                <span className="tk">{q.code}</span>
                <span className="tk-name">{q.name}</span>
              </td>
              <td>
                <span key={q.tickId} className={q.tick ? `flash-${q.tick}` : undefined}>
                  {fmt(q.last, q.dp)}
                </span>
              </td>
              <td className={dirClass(ch)}>{signed(ch, q.dp)}</td>
              <td className={dirClass(ch)}>{pct(q.last / q.prevClose - 1)}</td>
              <td>
                <span className="rng" title={`52W ${fmt(q.low52, q.dp)} – ${fmt(q.high52, q.dp)}`}>
                  <span className="rng-mark" style={{ left: `${pos * 100}%` }} />
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
