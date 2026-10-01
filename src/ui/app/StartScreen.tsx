import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Activity, Brain, Dices, FlaskConical, HeartPulse, History, Loader2, Play, ShieldAlert, Sparkles, Stethoscope, Thermometer, Trash2, Wind, Syringe, Bandage } from 'lucide-react';
import { SCENARIOS } from '@/sim/scenarios/library';
import { validateScenario, type ScenarioDefinition } from '@/sim/scenarios/schema';
import { makeSeedFromNumber } from '@/sim/core/rng';
import { useCase } from '@/client/stores';
import { localCaseRepository, type SavedCaseSummary } from '@/client/persistence';
import { api, health } from '@/client/api';
import { Badge, Button, inputCls } from '../common';
import { formatClock } from '@/sim/core/math';

const CATEGORY_ICON: Record<string, typeof Activity> = {
  respiratory: Wind,
  cardiovascular: HeartPulse,
  toxicology: FlaskConical,
  metabolic: Activity,
  trauma: Bandage,
  infection: Thermometer,
  environmental: Thermometer,
  mixed: Stethoscope,
};

function newSeed(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return makeSeedFromNumber(a[0]!);
}

export function StartScreen() {
  const startCase = useCase((s) => s.startCase);
  const resumeCase = useCase((s) => s.resumeCase);
  const toast = useCase((s) => s.toast);
  const [seed, setSeed] = useState(newSeed);
  const [saved, setSaved] = useState<SavedCaseSummary[]>([]);
  const [ai, setAi] = useState<{ ai: boolean; model: string | null } | null>(null);
  const [prompt, setPrompt] = useState('A difficult respiratory emergency in a young adult');
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState<ScenarioDefinition | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [revealTitles, setRevealTitles] = useState(false);

  useEffect(() => {
    localCaseRepository.list().then(setSaved).catch(() => setSaved([]));
    health().then((h) => setAi({ ai: h.ai, model: h.model }));
  }, []);

  const categories = useMemo(() => ['all', ...Array.from(new Set(SCENARIOS.map((s) => s.category)))], []);
  const shown = SCENARIOS.filter((s) => filter === 'all' || s.category === filter);

  const random = () => {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    const sc = SCENARIOS[a[0]! % SCENARIOS.length]!;
    startCase(seed, sc);
  };

  const generate = async () => {
    setGenerating(true);
    setGenerated(null);
    const r = await api.scenario({ prompt });
    setGenerating(false);
    if (!r.ok || !r.data) {
      toast(`Scenario generation unavailable: ${r.error ?? 'unknown error'}. Library cases still work.`, 'warning');
      return;
    }
    const check = validateScenario(r.data.scenario);
    if (!check.ok || !check.scenario) {
      toast(`Generated scenario failed validation: ${check.errors.slice(0, 2).join('; ')}`, 'error');
      return;
    }
    setGenerated(check.scenario);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="start-screen">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
        <Logo />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold tracking-tight">Vitalis</div>
          <div className="text-[11px] text-ink-3">Real-time procedural virtual patient</div>
        </div>
        <Badge tone="warn" className="ml-3">
          <ShieldAlert size={11} /> Educational simulation · not for clinical use
        </Badge>
        <div className="ml-auto flex items-center gap-2 text-[12px] text-ink-3">
          <span className={clsx('h-2 w-2 rounded-full', ai?.ai ? 'bg-good' : 'bg-ink-3')} />
          {ai == null ? 'Checking AI service…' : ai.ai ? `AI features on (${ai.model})` : 'AI features offline — simulator fully functional'}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto scroll-thin lg:grid-cols-[minmax(0,1fr)_360px] lg:overflow-hidden">
        <main className="min-h-0 overflow-y-auto px-6 py-6 scroll-thin lg:px-10">
          <section className="mb-8 grid gap-4 xl:grid-cols-[1.2fr_1fr]">
            <div className="relative overflow-hidden rounded-xl border border-line bg-surface p-6">
              <div className="pointer-events-none absolute -right-10 -top-10 h-56 w-56 rounded-full bg-accent/10 blur-3xl" />
              <h1 className="text-[26px] font-semibold leading-tight tracking-tight">Receive an undifferentiated patient.</h1>
              <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-ink-2">
                Every case is a continuously simulated organism — cardiovascular, respiratory, renal, metabolic, neurological and pharmacological models that interact in real time. There is no decision tree: the patient responds to what you do, and to what you don't.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Button variant="primary" size="lg" icon={<Dices size={16} />} onClick={random} data-testid="start-random">
                  Start random case
                </Button>
                <div className="flex items-center gap-1.5">
                  <input value={seed} onChange={(e) => setSeed(e.target.value.toUpperCase())} className={clsx(inputCls, 'h-10 w-[140px] font-mono')} aria-label="Patient seed" data-testid="seed-input" />
                  <Button variant="ghost" size="lg" onClick={() => setSeed(newSeed())} title="New seed">
                    <Dices size={15} />
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-[11.5px] text-ink-3">The seed fully determines the generated patient. Same seed + same actions reproduce the same case.</p>
            </div>

            <div className="rounded-xl border border-line bg-surface p-5">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles size={15} className="text-accent" />
                <h2 className="text-[13px] font-semibold">Instructor: generate a case with AI</h2>
              </div>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className={clsx(inputCls, 'h-auto resize-none py-2 leading-snug')} data-testid="ai-scenario-prompt" />
              <div className="mt-2 flex items-center gap-2">
                <Button variant="subtle" onClick={generate} disabled={generating || !ai?.ai} icon={generating ? <Loader2 size={14} className="animate-spin" /> : <Brain size={14} />}>
                  {generating ? 'Generating & validating…' : 'Generate scenario'}
                </Button>
                {!ai?.ai && <span className="text-[11px] text-ink-3">Requires OPENAI_API_KEY on the server.</span>}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-ink-3">The model may only compose pathology modules, parameters and drugs the deterministic simulator supports; output is schema-validated before use.</p>
              {generated && (
                <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft p-3 fade-in-up">
                  <div className="text-[13px] font-semibold">{generated.title}</div>
                  <div className="text-[12px] text-ink-2">{generated.tagline}</div>
                  <div className="mt-1 text-[11px] text-ink-3">Modules: {generated.pathologies.map((p) => p.type).join(', ')}</div>
                  <Button className="mt-2" variant="primary" size="sm" icon={<Play size={13} />} onClick={() => startCase(seed, generated)}>
                    Start generated case
                  </Button>
                </div>
              )}
            </div>
          </section>

          <section>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="mr-2 text-[13px] font-semibold uppercase tracking-[0.08em] text-ink-3">Case library</h2>
              {categories.map((c) => (
                <button key={c} onClick={() => setFilter(c)} className={clsx('rounded-full border px-2.5 py-0.5 text-[12px] capitalize', filter === c ? 'border-accent/60 bg-accent-soft text-accent' : 'border-line text-ink-2 hover:text-ink')}>
                  {c}
                </button>
              ))}
              <label className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-3">
                <input type="checkbox" checked={revealTitles} onChange={(e) => setRevealTitles(e.target.checked)} />
                Instructor view (show diagnoses)
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" data-testid="scenario-grid">
              {shown.map((sc) => {
                const Icon = CATEGORY_ICON[sc.category] ?? Stethoscope;
                return (
                  <button key={sc.id} onClick={() => startCase(seed, sc)} className="group flex flex-col rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-surface-2" data-testid={`scenario-${sc.id}`}>
                    <div className="flex items-center gap-2">
                      <span className="grid h-8 w-8 place-items-center rounded-lg bg-surface-3 text-ink-2 group-hover:text-accent">
                        <Icon size={16} />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-[14px] font-semibold">{sc.title}</div>
                        <div className="text-[11px] capitalize text-ink-3">{sc.category}</div>
                      </div>
                      <div className="ml-auto flex gap-0.5" title={`Difficulty ${sc.difficulty}/5`}>
                        {[1, 2, 3, 4, 5].map((d) => (
                          <span key={d} className={clsx('h-1.5 w-3 rounded-full', d <= sc.difficulty ? 'bg-accent' : 'bg-surface-3')} />
                        ))}
                      </div>
                    </div>
                    <p className="mt-2.5 text-[12.5px] leading-snug text-ink-2">{sc.tagline}</p>
                    {revealTitles && <p className="mt-2 text-[11.5px] text-warn">Dx: {sc.hiddenDiagnosis}</p>}
                  </button>
                );
              })}
            </div>
          </section>
        </main>

        <aside className="min-h-0 overflow-y-auto border-l border-line bg-surface px-5 py-6 scroll-thin">
          <div className="mb-3 flex items-center gap-2">
            <History size={15} className="text-ink-3" />
            <h2 className="text-[13px] font-semibold">Saved cases</h2>
          </div>
          {saved.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">Cases autosave while running. They will appear here so you can resume or review them.</p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="saved-cases">
              {saved.map((c) => (
                <li key={c.id} className="rounded-lg border border-line bg-surface-2 p-3">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{c.title}</div>
                      <div className="truncate text-[11.5px] text-ink-3">
                        {c.patientName} · {formatClock(c.simTime)} · {c.phase === 'ended' ? 'ended' : 'in progress'}
                        {!c.alive && ' · died'}
                      </div>
                    </div>
                    <Button size="sm" variant="subtle" onClick={() => void resumeCase(c.id)} data-testid="resume-case">
                      {c.phase === 'ended' ? 'Review' : 'Resume'}
                    </Button>
                    <button
                      className="text-ink-3 hover:text-danger"
                      title="Delete"
                      onClick={async () => {
                        await localCaseRepository.remove(c.id);
                        setSaved(await localCaseRepository.list());
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-ink-3">seed {c.seed}</div>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-8 rounded-lg border border-line bg-surface-2 p-4 text-[12px] leading-relaxed text-ink-2">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-ink">
              <Syringe size={13} /> About the simulation
            </div>
            Physiology, pharmacology and outcomes are computed by a deterministic engine. The optional AI only voices the patient, answers teaching questions, drafts scenarios and writes debriefs — it never decides what happens to the patient. Models are simplified and not clinically validated.
          </div>
        </aside>
      </div>
    </div>
  );
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--surface-3)" />
      <path d="M4 17h6l2.5-6 4 12 3-9 1.8 3H28" fill="none" stroke="var(--accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
