import { useEffect } from 'react';
import { DEFAULT_LAYOUT, PANELS, SLOTS, SLOT_HINT, assign, type Layout, type PanelKey } from '../lib/layout';
import { useHealth } from '../lib/server';
import Brokers from './settings/Brokers';
import Connections from './settings/Connections';
import Instruments from './settings/Instruments';
import { AuditTab, ImportExportTab, KeysTab } from './settings/Misc';
import { IndicatorsTab, ModelsTab } from './settings/Plugins';
import Rules from './settings/Rules';

export const TABS = [
  { id: 'data', label: 'Data Sources' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'news', label: 'News' },
  { id: 'models', label: 'Models' },
  { id: 'indicators', label: 'Indicators & Python' },
  { id: 'rules', label: 'Signals & Rules' },
  { id: 'actions', label: 'Actions & Integrations' },
  { id: 'brokers', label: 'Brokers & Risk' },
  { id: 'keys', label: 'Keys' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'io', label: 'Import / Export' },
  { id: 'audit', label: 'Audit Log' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

type Props = { tab: TabId; onTab: (t: TabId) => void; onClose: () => void; layout: Layout; onLayout: (l: Layout) => void; selected: string };

export default function Settings({ tab, onTab, onClose, layout, onLayout, selected }: Props) {
  const health = useHealth();

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && (document.activeElement as HTMLElement)?.tagName !== 'INPUT') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const offline = health === null;
  const needsServer = tab !== 'workspace';

  return (
    <div className="settings">
      <nav className="st-nav">
        <div className="st-nav-title">SETTINGS</div>
        {TABS.map((t) => <button key={t.id} className={t.id === tab ? 'on' : ''} onClick={() => onTab(t.id)}>{t.label}</button>)}
        <div className="st-nav-foot">
          <span className={`st-dot ${health ? 'ok' : health === null ? 'bad' : 'unk'}`} />
          {health ? `Server ${health.version}` : health === null ? 'Server offline' : 'Connecting…'}
          {health && <div className="sub">Python: {health.python.available ? `${health.python.plugins} plugins` : 'off'}</div>}
        </div>
        <button className="st-close" onClick={onClose}>← Back to terminal <kbd>Esc</kbd></button>
      </nav>
      <main className="st-main">
        <h2 className="st-title">{TABS.find((t) => t.id === tab)?.label}</h2>
        {offline && needsServer ? (
          <div className="st-offline">
            <b>The local server is not running.</b> Connectors, rules, Python plugins and trading run in the Dhoomberg server so your API keys
            stay off the browser and rules keep running when the tab is closed.
            <pre className="st-code">npm start          # terminal + server together{'\n'}# or, if the UI is already running:{'\n'}npm run server</pre>
            The terminal keeps working in demo mode without it.
          </div>
        ) : (
          <>
            {tab === 'data' && <Connections kind="datasource" intro="Price and time-series sources. Presets fill in the API details; 'Generic REST' maps any other JSON/CSV API with a URL template and field paths. After connecting, add instruments to choose symbols." />}
            {tab === 'instruments' && <Instruments />}
            {tab === 'news' && <Connections kind="news" intro="Every enabled source feeds the Wire panel, news-sentiment rule conditions and the LLM analyst. Items are tagged to commodities and scored. Provider sentiment is used when available, otherwise a simple headline lexicon (labelled as such)." />}
            {tab === 'models' && <ModelsTab />}
            {tab === 'indicators' && <IndicatorsTab />}
            {tab === 'rules' && <Rules initialInstrument={selected} />}
            {tab === 'actions' && <Connections kind="action" intro="Where rules send things: messages, spreadsheets, databases, ERPs and ticketing. Use 'Test' to send a sample event. The generic webhook covers Zapier, Make, n8n, Power Automate and anything with an HTTP endpoint." />}
            {tab === 'brokers' && <Brokers />}
            {tab === 'keys' && <KeysTab />}
            {tab === 'workspace' && <WorkspaceTab layout={layout} onLayout={onLayout} />}
            {tab === 'io' && <ImportExportTab />}
            {tab === 'audit' && <AuditTab />}
          </>
        )}
      </main>
    </div>
  );
}

function WorkspaceTab({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  return (
    <div>
      <p className="st-intro">Choose which panel sits in each slot. You can also swap panels from the ▾ in any panel header. Saved per browser, and to the server when it runs.</p>
      <div className="ws-grid">
        {SLOTS.map((s) => (
          <div key={s} className={`ws-slot ws-${s}`}>
            <span className="sub">{SLOT_HINT[s]}</span>
            <select value={layout[s]} onChange={(e) => onLayout(assign(layout, s, e.target.value as PanelKey))}>
              {(Object.keys(PANELS) as PanelKey[]).map((p) => <option key={p} value={p}>{PANELS[p].title}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="st-toolbar">
        <button onClick={() => onLayout(DEFAULT_LAYOUT)}>Reset layout</button>
        <button onClick={() => { try { localStorage.removeItem('dhoomberg_watchlist'); } catch { /* ignore */ } window.location.reload(); }}>Reset watchlist</button>
      </div>
    </div>
  );
}
