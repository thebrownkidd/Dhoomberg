import type { Catalog } from '../components/RuleBuilder';
import type { IndicatorMeta } from '../../shared/indicators';
import type { Connection, PluginManifest } from '../../shared/types';
import { api, useServerData } from './server';

type IndicatorList = { builtin: IndicatorMeta[]; python: Catalog['indicators'] };

export async function loadCatalog(): Promise<Catalog> {
  const [instruments, ind, models, conns, plugins] = await Promise.all([
    api.get<Catalog['instruments']>('/instruments'),
    api.get<IndicatorList>('/indicators'),
    api.get<Catalog['models']>('/models'),
    api.get<Connection[]>('/connections'),
    api.get<{ plugins: PluginManifest[] }>('/plugins').then((r) => r.plugins),
  ]);
  const kindOf = (c: Connection) => plugins.find((p) => p.id === c.pluginId);
  const on = conns.filter((c) => c.enabled);
  return {
    instruments,
    indicators: [...ind.builtin, ...ind.python],
    models,
    actions: on.filter((c) => kindOf(c)?.kind === 'action'),
    brokers: on.filter((c) => kindOf(c)?.kind === 'broker'),
    llms: on.filter((c) => kindOf(c)?.kind === 'model' && kindOf(c)?.capabilities?.llm),
    plugins,
  };
}

export function useCatalog() {
  return useServerData(loadCatalog, ['connections', 'plugins']);
}
