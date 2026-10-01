import { createStore, del, get, keys, set } from 'idb-keyval';

/**
 * Case persistence. The prototype stores cases in IndexedDB; the
 * `CaseRepository` interface is what a server/database implementation would
 * provide later (e.g. POST /api/cases, GET /api/cases/:id).
 */
export interface SavedCaseSummary {
  id: string;
  savedAt: number;
  title: string;
  patientName: string;
  seed: string;
  scenarioId: string;
  simTime: number;
  phase: 'active' | 'ended';
  alive: boolean;
}

export interface SavedCase extends SavedCaseSummary {
  version: 1;
  engineJson: string;
  /** Debrief text if generated */
  debrief?: unknown;
  chat?: { role: 'user' | 'patient' | 'system'; text: string; t: number }[];
}

export interface CaseRepository {
  list(): Promise<SavedCaseSummary[]>;
  load(id: string): Promise<SavedCase | null>;
  save(c: SavedCase): Promise<void>;
  remove(id: string): Promise<void>;
}

const store = typeof indexedDB !== 'undefined' ? createStore('vitalis-cases', 'cases') : undefined;

export const localCaseRepository: CaseRepository = {
  async list() {
    if (!store) return [];
    const ks = (await keys(store)) as string[];
    const items = await Promise.all(ks.map((k) => get<SavedCase>(k, store)));
    return items
      .filter((x): x is SavedCase => !!x)
      .map(({ engineJson: _e, debrief: _d, chat: _c, ...summary }) => summary)
      .sort((a, b) => b.savedAt - a.savedAt);
  },
  async load(id) {
    if (!store) return null;
    return (await get<SavedCase>(id, store)) ?? null;
  },
  async save(c) {
    if (!store) return;
    await set(c.id, c, store);
  },
  async remove(id) {
    if (!store) return;
    await del(id, store);
  },
};

const LAST_KEY = 'vitalis.lastCaseId';
export function rememberLastCase(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    /* storage unavailable */
  }
}
export function lastCaseId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}
