/**
 * Thin client for the server-side AI endpoints. The OpenAI key never reaches
 * the browser; every call degrades gracefully (returns `{ ok: false }`) so the
 * simulator remains fully usable without AI.
 */
export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Where the API lives. Empty (same origin) by default; set VITE_API_BASE at build time when the
 * static front end is hosted separately from the Node server (e.g. GitHub Pages + a hosted API).
 * This is a public URL, never a secret.
 */
const API_BASE = String(import.meta.env?.VITE_API_BASE ?? '').replace(/\/$/, '');

async function post<T>(path: string, body: unknown, timeoutMs = 45000): Promise<ApiResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } & Record<string, unknown> | null;
    if (!res.ok || !json || json.ok === false) return { ok: false, error: json?.error ?? `HTTP ${res.status}` };
    return { ok: true, data: json as unknown as T };
  } catch (e) {
    return { ok: false, error: (e as Error).name === 'AbortError' ? 'AI request timed out' : 'AI service unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export interface Health {
  ok: boolean;
  ai: boolean;
  model: string | null;
}

let healthCache: Promise<Health> | null = null;
export function health(): Promise<Health> {
  if (!healthCache) {
    healthCache = fetch(`${API_BASE}/api/health`)
      .then((r) => (r.ok ? (r.json() as Promise<Health>) : { ok: false, ai: false, model: null }))
      .catch(() => ({ ok: false, ai: false, model: null }));
  }
  return healthCache;
}

export const api = {
  patientChat: (body: unknown) => post<{ ok: true; reply: { speech: string; nonverbal: string; emotion: string } }>('/api/ai/patient', body, 30000),
  instructor: (body: unknown) => post<{ ok: true; reply: { answer: string; hint_level: string; references_to_observations: string[] } }>('/api/ai/instructor', body, 40000),
  scenario: (body: unknown) => post<{ ok: true; scenario: unknown; attempts: number; warnings: string[] }>('/api/ai/scenario', body, 90000),
  debrief: (body: unknown) => post<{ ok: true; debrief: unknown }>('/api/ai/debrief', body, 120000),
};
