import { useEffect, useState, type ReactNode } from 'react';
import { PANELS, type PanelKey, type Slot } from '../lib/layout';

export type PanelId = PanelKey;

type Props = {
  id: PanelId;
  slot: Slot;
  fn: string;
  title: string;
  meta?: ReactNode;
  active: boolean;
  onActivate: (id: PanelId) => void;
  onSwap: (slot: Slot, panel: PanelKey) => void;
  children: ReactNode;
};

export default function Panel({ id, slot, fn, title, meta, active, onActivate, onSwap, children }: Props) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);

  return (
    <section id={`panel-${id}`} className={`panel p-${id}${active ? ' active' : ''}`} style={{ gridArea: slot }} onMouseDown={() => onActivate(id)}>
      <header className="panel-head">
        <span className="fn">{fn}</span>
        <span className="panel-title">{title}</span>
        {meta && <span className="panel-meta">{meta}</span>}
        <span className="panel-swap" onClick={(e) => e.stopPropagation()}>
          <button className="panel-swap-btn" title="Show a different panel here" onClick={() => setOpen((v) => !v)}>▾</button>
          {open && (
            <span className="panel-swap-menu">
              {(Object.keys(PANELS) as PanelKey[]).map((p) => (
                <button key={p} className={p === id ? 'on' : ''} onClick={() => { onSwap(slot, p); setOpen(false); }}>
                  <span className="fn-mini">{PANELS[p].fn}</span>{PANELS[p].title}
                </button>
              ))}
            </span>
          )}
        </span>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}
