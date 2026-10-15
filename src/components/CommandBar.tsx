import { useEffect, useRef, useState, type RefObject } from 'react';

export type CmdResult = { kind: 'ok' | 'info' | 'error'; msg: string } | null;

const CLOCKS = [
  { label: 'MUM', tz: 'Asia/Kolkata' },
  { label: 'SGP', tz: 'Asia/Singapore' },
  { label: 'LDN', tz: 'Europe/London' },
  { label: 'NYC', tz: 'America/New_York' },
];

function time(tz: string, d: Date): string {
  return d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

type Props = {
  inputRef: RefObject<HTMLInputElement>;
  onSubmit: (raw: string) => CmdResult | Promise<CmdResult>;
  onSettings: () => void;
  settingsOpen: boolean;
  halted: boolean;
};

export default function CommandBar({ inputRef, onSubmit, onSettings, settingsOpen, halted }: Props) {
  const [value, setValue] = useState('');
  const [result, setResult] = useState<CmdResult>(null);
  const [now, setNow] = useState(() => new Date());
  const [hist, setHist] = useState<string[]>([]);
  const histIdx = useRef(-1);
  const seq = useRef(0);

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  function submit() {
    if (!value.trim()) return;
    setHist((h) => [value, ...h.filter((x) => x !== value)].slice(0, 50));
    histIdx.current = -1;
    const r = onSubmit(value);
    if (r instanceof Promise) {
      const n = ++seq.current;
      setResult({ kind: 'info', msg: '…' });
      setValue('');
      r.then((x) => n === seq.current && setResult(x));
      return;
    }
    setResult(r);
    if (r?.kind !== 'error') setValue('');
  }

  return (
    <div className="cmdbar">
      <span className="brand">DHOOMBERG</span>
      <form className="cmd" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label htmlFor="cmd-input" className="prompt">&gt;</label>
        <input
          id="cmd-input"
          ref={inputRef}
          value={value}
          autoComplete="off"
          spellCheck={false}
          placeholder="COCOA · IND ADD RSI · MODEL HOLT · BUY 10 SUGAR · SETTINGS · HELP"
          onChange={(e) => {
            setValue(e.target.value);
            if (result?.kind === 'error') setResult(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setValue(''); setResult(null); e.currentTarget.blur(); }
            if (e.key === 'ArrowUp' && hist.length) {
              e.preventDefault();
              histIdx.current = Math.min(hist.length - 1, histIdx.current + 1);
              setValue(hist[histIdx.current]);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              histIdx.current = Math.max(-1, histIdx.current - 1);
              setValue(histIdx.current < 0 ? '' : hist[histIdx.current]);
            }
          }}
        />
        <button type="submit" className="go">GO</button>
      </form>
      {result && <span className={`cmd-msg ${result.kind}`} title={result.msg}>{result.msg}</span>}
      {halted && <span className="halted-badge">HALTED</span>}
      <div className="clocks">
        {CLOCKS.map((c) => (
          <span key={c.label} className="clock">
            <span className="clock-label">{c.label}</span>
            {time(c.tz, now)}
          </span>
        ))}
      </div>
      <button className={`gear${settingsOpen ? ' on' : ''}`} onClick={onSettings} title="Settings (SETTINGS)" aria-label="Settings">⚙</button>
    </div>
  );
}
