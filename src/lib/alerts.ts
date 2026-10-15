/** Price threshold alerts — stored in localStorage, checked on each tick. */

export type AlertDir = 'above' | 'below';
export type PriceAlert = {
  id: string;
  commodityId: string;
  commodityName: string;
  direction: AlertDir;
  threshold: number;
  notify: boolean;       // request browser Notification
  createdAt: string;
  firedAt: string | null;
};

const STORAGE_KEY = 'dhoomberg_alerts';

function load(): PriceAlert[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function save(alerts: PriceAlert[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
  } catch { /* storage full — ignore */ }
}

export function getAlerts(): PriceAlert[] {
  return load();
}

export function addAlert(a: Omit<PriceAlert, 'id' | 'createdAt' | 'firedAt'>): PriceAlert {
  const alert: PriceAlert = {
    ...a,
    id: `${a.commodityId}_${a.direction}_${a.threshold}_${Date.now()}`,
    createdAt: new Date().toISOString(),
    firedAt: null,
  };
  save([...load().filter((x) => !(x.commodityId === a.commodityId && x.direction === a.direction && x.threshold === a.threshold)), alert]);
  return alert;
}

export function removeAlerts(commodityId?: string) {
  if (!commodityId) {
    save([]);
  } else {
    save(load().filter((a) => a.commodityId !== commodityId));
  }
}

/** Call on every price tick. Returns alerts that just fired. */
export function checkAlerts(commodityId: string, price: number): PriceAlert[] {
  const all = load();
  const fired: PriceAlert[] = [];
  const updated = all.map((a) => {
    if (a.commodityId !== commodityId || a.firedAt) return a;
    const triggered = a.direction === 'above' ? price >= a.threshold : price <= a.threshold;
    if (!triggered) return a;
    fired.push(a);
    return { ...a, firedAt: new Date().toISOString() };
  });
  if (fired.length) save(updated);
  return fired;
}

/** Request Notification permission if needed. */
export async function requestNotifyPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

export function fireNotification(title: string, body: string) {
  if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico' });
  }
}
