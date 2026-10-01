import { create } from 'zustand';
import type { CaseMeta, SimSnapshot } from '@/sim/engine/snapshot';
import type { SimulationEvent } from '@/sim/types';
import type { SimAction } from '@/sim/interventions/actions';
import type { ScenarioDefinition } from '@/sim/scenarios/schema';
import type { AnatomyLayerId, AnatomyLayerSettings, AnatomyStructureInfo, CameraPreset } from '@/three/types';
import { createDefaultLayerSettings } from '@/three/types';
import { simClient } from './simClient';
import { lastCaseId, localCaseRepository, rememberLastCase, type SavedCase } from './persistence';

export type Screen = 'start' | 'loading' | 'handoff' | 'case' | 'debrief';

export interface ChatMessage {
  id: number;
  role: 'user' | 'patient' | 'system' | 'instructor';
  text: string;
  t: number;
  /** Non-verbal cue (e.g. "groans", "no response") */
  cue?: string;
  source?: 'ai' | 'fallback';
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'warning' | 'error' | 'good';
}

interface CaseState {
  screen: Screen;
  caseId: string | null;
  meta: CaseMeta | null;
  snapshot: SimSnapshot | null;
  events: SimulationEvent[];
  speed: number;
  chat: ChatMessage[];
  instructorChat: ChatMessage[];
  debrief: unknown;
  diagnosisSubmitted: string | null;
  toasts: Toast[];
  setScreen: (s: Screen) => void;
  startCase: (seed: string, scenario: ScenarioDefinition) => void;
  resumeCase: (id: string) => Promise<boolean>;
  dispatch: (a: SimAction) => void;
  setSpeed: (n: number) => void;
  addChat: (m: Omit<ChatMessage, 'id'>) => void;
  addInstructorChat: (m: Omit<ChatMessage, 'id'>) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
  save: () => Promise<void>;
  endCase: (reason: string, diagnosis: string) => void;
  setDebrief: (d: unknown) => void;
  exitToStart: () => void;
}

let msgId = 1;
let toastId = 1;

function newCaseId(): string {
  return `case-${Date.now().toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}`;
}

export const useCase = create<CaseState>((set, getState) => ({
  screen: 'start',
  caseId: null,
  meta: null,
  snapshot: null,
  events: [],
  speed: 1,
  chat: [],
  instructorChat: [],
  debrief: null,
  diagnosisSubmitted: null,
  toasts: [],
  setScreen: (screen) => set({ screen }),
  startCase: (seed, scenario) => {
    const id = newCaseId();
    set({ screen: 'loading', caseId: id, meta: null, snapshot: null, events: [], chat: [], instructorChat: [], debrief: null, diagnosisSubmitted: null });
    rememberLastCase(id);
    const client = simClient();
    client.setSpeed(0);
    client.create(seed, scenario);
  },
  resumeCase: async (id) => {
    const saved = await localCaseRepository.load(id);
    if (!saved) return false;
    set({ screen: 'loading', caseId: id, meta: null, snapshot: null, events: [], chat: (saved.chat as ChatMessage[] | undefined)?.map((c) => ({ ...c, id: msgId++ })) ?? [], debrief: saved.debrief ?? null, diagnosisSubmitted: null });
    rememberLastCase(id);
    const client = simClient();
    client.setSpeed(0);
    client.restore(saved.engineJson);
    return true;
  },
  dispatch: (a) => simClient().dispatch(a),
  setSpeed: (n) => {
    simClient().setSpeed(n);
    set({ speed: n });
  },
  addChat: (m) => set((s) => ({ chat: [...s.chat, { ...m, id: msgId++ }] })),
  addInstructorChat: (m) => set((s) => ({ instructorChat: [...s.instructorChat, { ...m, id: msgId++ }] })),
  toast: (text, tone = 'info') => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }));
    setTimeout(() => getState().dismissToast(id), 4500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  save: async () => {
    const { caseId, meta, snapshot, chat, debrief } = getState();
    if (!caseId || !meta || !snapshot) return;
    const json = await simClient().serialize();
    const rec: SavedCase = {
      version: 1,
      id: caseId,
      savedAt: Date.now(),
      title: meta.scenarioTitle,
      patientName: meta.patient.name,
      seed: meta.seed,
      scenarioId: meta.scenarioId,
      simTime: snapshot.t,
      phase: snapshot.status.phase,
      alive: snapshot.status.alive,
      engineJson: json,
      debrief: debrief ?? undefined,
      chat: chat.map(({ role, text, t }) => ({ role: role === 'instructor' ? 'system' : role, text, t })),
    };
    await localCaseRepository.save(rec);
  },
  endCase: (reason, diagnosis) => {
    simClient().dispatch({ type: 'case.end', reason, diagnosis });
    set({ diagnosisSubmitted: diagnosis });
  },
  setDebrief: (d) => set({ debrief: d }),
  exitToStart: () => {
    simClient().setSpeed(0);
    rememberLastCase(null);
    set({ screen: 'start', caseId: null, meta: null, snapshot: null, events: [], chat: [], debrief: null });
  },
}));

// Wire the worker to the store (throttled for React; render loops read simClient().latest)
let wired = false;
export function wireSimulation(): void {
  if (wired) return;
  wired = true;
  const client = simClient();
  let lastUi = 0;
  client.onCreated((meta, snapshot, restored) => {
    useCase.setState((s) => ({
      meta,
      snapshot,
      events: [...snapshot.events],
      screen: restored ? (snapshot.status.phase === 'ended' ? 'debrief' : 'case') : 'handoff',
      speed: 0,
      chat: s.chat,
    }));
    lastUi = performance.now();
  });
  client.onSnapshot((snap) => {
    const now = performance.now();
    const hasEvents = snap.events.length > 0;
    if (hasEvents)
      useCase.setState((s) => {
        const last = s.events.length ? s.events[s.events.length - 1]!.id : 0;
        const fresh = snap.events.filter((e) => e.id > last);
        return fresh.length ? { events: [...s.events, ...fresh] } : {};
      });
    if (now - lastUi > 250 || hasEvents) {
      lastUi = now;
      useCase.setState({ snapshot: snap });
    }
  });
  client.onError((m) => useCase.getState().toast(m, 'error'));
  window.addEventListener('pagehide', () => {
    const st = useCase.getState();
    if ((st.screen === 'case' || st.screen === 'debrief') && st.caseId) void st.save();
  });
  // Autosave every 20 s of wall time while a case is open
  setInterval(() => {
    const st = useCase.getState();
    if (st.screen === 'case' && st.caseId) st.save().catch(() => undefined);
  }, 20000);
}

export async function tryResumeLast(): Promise<boolean> {
  const id = lastCaseId();
  if (!id) return false;
  return useCase.getState().resumeCase(id);
}

// ---------------------------------------------------------------- UI store

export type PanelId = 'assess' | 'airway' | 'circulation' | 'meds' | 'procedures' | 'diagnostics' | 'anatomy' | 'talk' | 'timeline' | 'instructor' | 'pharm' | null;
export type Tool = 'pointer' | 'stethoscope' | 'palpate' | 'inspect';

export interface AlarmLimits {
  hrLow: number;
  hrHigh: number;
  spo2Low: number;
  sbpLow: number;
  sbpHigh: number;
  rrLow: number;
  rrHigh: number;
  etco2Low: number;
  etco2High: number;
}

interface UiState {
  panel: PanelId;
  preset: CameraPreset;
  presetNonce: number;
  layers: AnatomyLayerSettings;
  isolate: AnatomyLayerId | null;
  tool: Tool;
  selected: AnatomyStructureInfo | null;
  theme: 'dark' | 'light';
  audioEnabled: boolean;
  alarmsSilencedUntil: number;
  qrsTone: boolean;
  instructorMode: boolean;
  showTruth: boolean;
  limits: AlarmLimits;
  setPanel: (p: PanelId) => void;
  togglePanel: (p: Exclude<PanelId, null>) => void;
  setPreset: (p: CameraPreset) => void;
  setLayer: (id: AnatomyLayerId, patch: Partial<{ visible: boolean; opacity: number }>) => void;
  setIsolate: (id: AnatomyLayerId | null) => void;
  setTool: (t: Tool) => void;
  select: (s: AnatomyStructureInfo | null) => void;
  setTheme: (t: 'dark' | 'light') => void;
  set: (patch: Partial<UiState>) => void;
}

export const useUi = create<UiState>((set) => ({
  panel: null,
  preset: 'full',
  presetNonce: 0,
  layers: createDefaultLayerSettings(),
  isolate: null,
  tool: 'pointer',
  selected: null,
  theme: 'dark',
  audioEnabled: false,
  alarmsSilencedUntil: 0,
  qrsTone: true,
  instructorMode: false,
  showTruth: false,
  limits: { hrLow: 45, hrHigh: 130, spo2Low: 90, sbpLow: 90, sbpHigh: 180, rrLow: 8, rrHigh: 30, etco2Low: 25, etco2High: 50 },
  setPanel: (panel) => set({ panel }),
  togglePanel: (p) => set((s) => ({ panel: s.panel === p ? null : p })),
  setPreset: (preset) => set((s) => ({ preset, presetNonce: s.presetNonce + 1 })),
  setLayer: (id, patch) => set((s) => ({ layers: { ...s.layers, [id]: { ...s.layers[id], ...patch } } })),
  setIsolate: (isolate) => set({ isolate }),
  setTool: (tool) => set({ tool }),
  select: (selected) => set({ selected }),
  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
  set: (patch) => set(patch),
}));
