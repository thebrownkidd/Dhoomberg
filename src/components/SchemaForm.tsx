import type { JSONSchema } from '../../shared/types';

type Props = {
  schema: JSONSchema;
  value: Record<string, unknown>;
  secretHints?: Record<string, string>;
  onChange: (v: Record<string, unknown>) => void;
};

/** Renders a settings form for any plugin from its JSON Schema. Secrets are write-only. */
export default function SchemaForm({ schema, value, secretHints = {}, onChange }: Props) {
  const props = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  if (!props.length) return <p className="sf-empty">No settings needed.</p>;
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });

  return (
    <div className="sf">
      {props.map(([key, s]) => {
        const id = `sf-${key}`;
        const v = value[key] ?? (s['x-secret'] ? '' : s.default ?? '');
        const label = (
          <label htmlFor={id} className="sf-label">
            {s.title ?? key}{required.has(key) && <span className="sf-req">*</span>}
            {s['x-secret'] && <span className="sf-secret">secret</span>}
          </label>
        );
        let input;
        if (s.type === 'boolean') {
          input = <input id={id} type="checkbox" checked={!!(value[key] ?? s.default)} onChange={(e) => set(key, e.target.checked)} />;
        } else if (s.enum) {
          input = (
            <select id={id} value={String(v)} onChange={(e) => set(key, e.target.value)}>
              {s.enum.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          );
        } else if (s.type === 'number' || s.type === 'integer') {
          input = <input id={id} type="number" value={v === '' ? '' : Number(v)} min={s.minimum} max={s.maximum} step="any" onChange={(e) => set(key, e.target.value === '' ? '' : Number(e.target.value))} />;
        } else if (s.format === 'textarea' || s.format === 'json') {
          const bad = s.format === 'json' && typeof v === 'string' && v.trim() !== '' && (() => { try { JSON.parse(v); return false; } catch { return true; } })();
          input = (
            <>
              <textarea id={id} rows={s.format === 'json' ? 3 : 4} spellCheck={false} value={String(v)}
                placeholder={s['x-secret'] ? secretHints[key] ?? '' : s['x-placeholder']}
                onChange={(e) => set(key, e.target.value)} className={bad ? 'invalid' : undefined} />
              {bad && <span className="sf-err">Not valid JSON</span>}
            </>
          );
        } else {
          input = (
            <input id={id} type={s['x-secret'] ? 'password' : s.format === 'uri' ? 'url' : 'text'} autoComplete="off" spellCheck={false}
              value={String(v)}
              placeholder={s['x-secret'] ? (secretHints[key] ? `${secretHints[key]} (unchanged)` : '') : s['x-placeholder'] ?? (s.default !== undefined ? String(s.default) : '')}
              onChange={(e) => set(key, e.target.value)} />
          );
        }
        return (
          <div key={key} className={`sf-row${s.type === 'boolean' ? ' sf-check' : ''}`}>
            {label}
            <div className="sf-input">
              {input}
              {s.description && <div className="sf-help">{s.description}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Fills defaults so the saved config matches what the form showed. */
export function withDefaults(schema: JSONSchema, value: Record<string, unknown>): Record<string, unknown> {
  const out = { ...value };
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    if (out[k] === undefined && s.default !== undefined && !s['x-secret']) out[k] = s.default;
  }
  return out;
}
