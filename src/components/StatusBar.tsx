import { useHealth } from '../lib/server';

export default function StatusBar({ lastTick, onSettings }: { lastTick: Date | null; onSettings: () => void }) {
  const h = useHealth();
  const live = h?.connections.some((c) => c.kind === 'broker' && c.live);
  const feeds = h?.connections.filter((c) => c.enabled && (c.kind === 'datasource' || c.kind === 'news')) ?? [];

  return (
    <footer className="status">
      {h?.halted && <span className="halted-badge">HALTED</span>}
      {h ? (
        <span className={live ? 'live-badge' : 'paper-badge'}>{live ? 'LIVE TRADING ARMED' : 'PAPER'}</span>
      ) : (
        <span className="demo" title="Local server not running: demo data only">DEMO · SERVER OFF</span>
      )}
      <span className="sources">
        {h && !feeds.length && <span className="src src-mock"><i />Demo prices</span>}
        {feeds.slice(0, 6).map((c) => (
          <span key={c.id} className={`src ${c.ok === false ? 'src-bad' : c.ok ? 'src-live' : 'src-mock'}`} title={c.ok === false ? 'Last test failed' : c.ok ? 'OK' : 'Not tested'}>
            <i />{c.name}
          </span>
        ))}
        {feeds.length > 6 && <span className="src">+{feeds.length - 6}</span>}
        {h && <span className={`src ${h.python.available ? 'src-live' : 'src-mock'}`} title={h.python.error ?? ''}><i />Python {h.python.available ? h.python.plugins : 'off'}</span>}
      </span>
      <span className="hints">
        <kbd>/</kbd> command <kbd>HELP</kbd> functions <button className="link" onClick={onSettings}>SETTINGS</button>
      </span>
      <span className="updated">{lastTick ? `Last tick ${lastTick.toLocaleTimeString('en-GB')}` : 'Waiting for ticks…'}</span>
    </footer>
  );
}
