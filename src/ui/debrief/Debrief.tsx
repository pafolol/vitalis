import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ArrowLeft, CheckCircle2, CircleDashed, Download, Loader2, ShieldAlert, Sparkles, XCircle } from 'lucide-react';
import { useCase, useUi } from '@/client/stores';
import { simClient } from '@/client/simClient';
import { api, health } from '@/client/api';
import { analyzeCase, type DebriefAnalysis } from '@/sim/debrief/analyze';
import type { HistoryPayload } from '@/sim/engine/snapshot';
import type { SimulationEvent } from '@/sim/types';
import { formatClock } from '@/sim/core/math';
import { Badge, Button } from '../common';
import { Logo } from '../app/StartScreen';

interface AiDebrief {
  summary: string;
  timeline_commentary: { time: string; comment: string }[];
  key_decision_points: { time: string; decision: string; assessment: string }[];
  physiology_explanation: string;
  missed_information: string[];
  alternative_actions: string[];
  learning_points: string[];
  simulator_vs_real_world: string;
}

export default function Debrief() {
  const meta = useCase((s) => s.meta);
  const snapshot = useCase((s) => s.snapshot);
  const exit = useCase((s) => s.exitToStart);
  const debrief = useCase((s) => s.debrief) as AiDebrief | null;
  const setDebrief = useCase((s) => s.setDebrief);
  const save = useCase((s) => s.save);
  const diagnosisSubmitted = useCase((s) => s.diagnosisSubmitted);
  const theme = useUi((s) => s.theme);
  const [events, setEvents] = useState<SimulationEvent[]>([]);
  const [hist, setHist] = useState<HistoryPayload | null>(null);
  const [aiState, setAiState] = useState<'idle' | 'loading' | 'error' | 'unavailable'>('idle');

  useEffect(() => {
    simClient().allEvents().then(setEvents).catch(() => undefined);
    simClient().history().then(setHist).catch(() => undefined);
  }, []);

  const diagnosis = useMemo(() => {
    const endEv = [...events].reverse().find((e) => e.code === 'case.end');
    return (endEv?.data?.['diagnosis'] as string | undefined) ?? diagnosisSubmitted;
  }, [events, diagnosisSubmitted]);

  const analysis: DebriefAnalysis | null = useMemo(() => {
    if (!meta || !snapshot || !hist) return null;
    return analyzeCase(meta.scenario, events, hist.samples, snapshot.status, diagnosis ?? null);
  }, [meta, snapshot, hist, events, diagnosis]);

  const generate = async () => {
    if (!meta || !analysis || !hist) return;
    const h = await health();
    if (!h.ai) {
      setAiState('unavailable');
      return;
    }
    setAiState('loading');
    const trend = hist.samples.filter((_, i) => i % 6 === 0).map((s) => ({ t: formatClock(s.t), hr: s.hr, map: s.map, spo2: s.spo2, rr: s.rr, gcs: s.gcs, rhythm: s.rhythm, lactate: s.lactate, glucose: s.glucose, k: s.k }));
    const r = await api.debrief({
      scenario: { title: meta.scenarioTitle, hiddenDiagnosis: meta.scenario.hiddenDiagnosis, learningObjectives: meta.scenario.learningObjectives, keyEvidence: meta.scenario.keyEvidence, simulatorNotes: meta.scenario.debriefNotes, modules: meta.scenario.pathologies.map((p) => p.type) },
      patient: { age: meta.patient.ageYears, sex: meta.patient.sex, history: meta.patient.history.map((x) => x.label), allergies: meta.patient.allergies.map((a) => a.agent) },
      analysis,
      events: events.map((e) => `${formatClock(e.t)} [${e.kind}] ${e.message}`).slice(0, 400),
      trend,
    });
    if (r.ok && r.data) {
      setDebrief(r.data.debrief);
      setAiState('idle');
      void save();
    } else setAiState('error');
  };

  const download = () => {
    const blob = new Blob([JSON.stringify({ meta: { ...meta, scenario: meta?.scenario.id }, analysis, aiDebrief: debrief, events, history: hist?.samples }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vitalis-debrief-${meta?.seed ?? 'case'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (!meta || !snapshot) return null;
  return (
    <div className="flex h-full flex-col" data-testid="debrief">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
        <Logo />
        <div className="leading-tight">
          <div className="text-[15px] font-semibold">Debrief · {meta.scenarioTitle}</div>
          <div className="text-[11.5px] text-ink-3">
            {meta.patient.name} · {meta.patient.ageYears}y {meta.patient.sex} · seed <span className="font-mono">{meta.seed}</span>
          </div>
        </div>
        <Badge tone="warn" className="ml-3">
          <ShieldAlert size={11} /> Simulator behaviour — not clinical guidance
        </Badge>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" icon={<Download size={14} />} onClick={download}>
            Export
          </Button>
          <Button variant="secondary" icon={<ArrowLeft size={14} />} onClick={exit} data-testid="debrief-exit">
            New case
          </Button>
        </div>
      </header>
      {!analysis ? (
        <div className="grid flex-1 place-items-center text-ink-3">
          <Loader2 className="animate-spin" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <div className="mx-auto grid max-w-6xl gap-5 px-6 py-6 lg:grid-cols-[1fr_360px]">
            <div className="flex flex-col gap-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="Outcome" value={analysis.survived ? 'Survived' : 'Died'} tone={analysis.survived ? 'good' : 'danger'} sub={analysis.outcome} />
                <Stat
                  label="Your diagnosis"
                  value={analysis.diagnosisSubmitted ?? '—'}
                  tone={analysis.diagnosisCorrect ? 'good' : analysis.diagnosisCorrect === false ? 'warn' : 'neutral'}
                  sub={analysis.diagnosisCorrect ? 'Matches the hidden diagnosis' : analysis.diagnosisCorrect === false ? 'Does not match' : 'Not submitted'}
                />
                <Stat label="Hidden diagnosis" value={analysis.hiddenDiagnosis} tone="neutral" sub={`Case length ${formatClock(analysis.duration)}`} />
              </div>

              {hist && <VitalsOverview hist={hist} events={events} dark={theme === 'dark'} />}

              <Card title="Key decision points">
                <ul className="flex flex-col gap-2" data-testid="decisions">
                  {analysis.decisions.map((d) => (
                    <li key={d.label} className="flex gap-2.5">
                      {d.done ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-good" /> : <XCircle size={16} className="mt-0.5 shrink-0 text-danger" />}
                      <div>
                        <div className="text-[13px] font-medium">
                          {d.label} <span className="font-mono text-[11.5px] text-ink-3">{d.at != null ? `at ${formatClock(d.at)}` : 'not done'}</span>
                        </div>
                        <div className="text-[12px] text-ink-2">{d.why}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card title="How the simulated patient responded">
                <p className="mb-2 text-[11.5px] text-ink-3">Change in tracked variables over the 5 simulated minutes after each intervention. When several interventions fall within the same window their effects overlap — attribute with care.</p>
                {analysis.responses.length === 0 ? (
                  <p className="text-[12.5px] text-ink-3">No treatments were given.</p>
                ) : (
                  <ol className="flex flex-col gap-2">
                    {analysis.responses.map((r, i) => (
                      <li key={i} className="grid grid-cols-[52px_1fr] gap-2 text-[12.5px]">
                        <span className="font-mono text-ink-3">{formatClock(r.t)}</span>
                        <span>
                          <span className="font-medium">{r.action}.</span> <span className="text-ink-2">{r.observation}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>

              <Card
                title="AI narrative debrief"
                action={
                  !debrief && (
                    <Button size="sm" variant="subtle" icon={aiState === 'loading' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} onClick={generate} disabled={aiState === 'loading'} data-testid="ai-debrief">
                      {aiState === 'loading' ? 'Writing debrief…' : 'Generate'}
                    </Button>
                  )
                }
              >
                {debrief ? (
                  <AiDebriefView d={debrief} />
                ) : (
                  <p className="text-[12.5px] text-ink-3">
                    {aiState === 'unavailable'
                      ? 'AI service not configured — the structured debrief on this page is computed deterministically from the event log and physiology.'
                      : aiState === 'error'
                        ? 'The AI debrief could not be generated. The structured analysis above and below is complete.'
                        : 'Optionally generate a narrative explanation grounded in this case’s event log and physiology.'}
                  </p>
                )}
              </Card>
            </div>

            <div className="flex flex-col gap-5">
              <Card title="Missed information">
                {analysis.missed.length === 0 ? <p className="text-[12.5px] text-good">Nothing flagged.</p> : <ul className="list-disc pl-4 text-[12.5px] leading-relaxed text-ink-2">{analysis.missed.map((m) => <li key={m}>{m}</li>)}</ul>}
              </Card>
              {analysis.harms.length > 0 && (
                <Card title="Adverse events">
                  <ul className="flex flex-col gap-1 text-[12.5px] text-danger">
                    {analysis.harms.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                </Card>
              )}
              <Card title="Alternatives the simulator supports">
                <ul className="list-disc pl-4 text-[12.5px] leading-relaxed text-ink-2">
                  {analysis.alternatives.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Card>
              <Card title="Learning objectives">
                <ul className="list-disc pl-4 text-[12.5px] leading-relaxed text-ink-2">
                  {meta.scenario.learningObjectives.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ul>
                {meta.scenario.debriefNotes.length > 0 && (
                  <div className="mt-3 rounded-lg bg-surface-2 p-3 text-[12px] leading-relaxed text-ink-2">
                    <div className="mb-1 font-semibold text-ink">How the simulator models this</div>
                    {meta.scenario.debriefNotes.map((n) => (
                      <p key={n} className="mb-1">
                        {n}
                      </p>
                    ))}
                  </div>
                )}
              </Card>
              <Card title="Full timeline">
                <ol className="flex max-h-[520px] flex-col gap-1 overflow-y-auto pr-1 scroll-thin" data-testid="debrief-timeline">
                  {events.map((e) => (
                    <li key={e.id} className="grid grid-cols-[46px_1fr] gap-2 text-[11.5px]">
                      <span className="font-mono text-ink-3">{formatClock(e.t)}</span>
                      <span className={clsx(e.severity === 'critical' ? 'text-danger' : e.kind === 'action' ? 'text-ink' : 'text-ink-2')}>
                        {e.message}
                        {e.data?.['hidden'] ? <span className="ml-1 rounded bg-warn-soft px-1 text-[9.5px] text-warn">was hidden</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: 'good' | 'danger' | 'warn' | 'neutral' }) {
  return (
    <div className={clsx('rounded-xl border p-4', tone === 'good' ? 'border-good/40 bg-good-soft' : tone === 'danger' ? 'border-danger/40 bg-danger-soft' : tone === 'warn' ? 'border-warn/40 bg-warn-soft' : 'border-line bg-surface')}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-1 text-[15px] font-semibold leading-snug">{value}</div>
      <div className="mt-1 text-[11.5px] text-ink-2">{sub}</div>
    </div>
  );
}

function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function AiDebriefView({ d }: { d: AiDebrief }) {
  return (
    <div className="flex flex-col gap-3 text-[12.5px] leading-relaxed" data-testid="ai-debrief-view">
      <p>{d.summary}</p>
      <div>
        <div className="mb-1 font-semibold">Why the patient responded as they did</div>
        <p className="text-ink-2">{d.physiology_explanation}</p>
      </div>
      {d.key_decision_points.length > 0 && (
        <div>
          <div className="mb-1 font-semibold">Decision points</div>
          <ul className="flex flex-col gap-1">
            {d.key_decision_points.map((k, i) => (
              <li key={i}>
                <span className="font-mono text-ink-3">{k.time}</span> {k.decision} — <span className="text-ink-2">{k.assessment}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="mb-1 font-semibold">Learning points</div>
        <ul className="list-disc pl-4 text-ink-2">
          {d.learning_points.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
      <p className="rounded-lg bg-warn-soft p-2.5 text-[12px] text-ink-2">
        <span className="font-semibold text-warn">Simulator vs real world: </span>
        {d.simulator_vs_real_world}
      </p>
    </div>
  );
}

const VITAL_SERIES = [
  { key: 'hr', label: 'HR', unit: '/min' },
  { key: 'map', label: 'MAP', unit: 'mmHg' },
  { key: 'spo2', label: 'SaO₂', unit: '%' },
] as const;

function VitalsOverview({ hist, events, dark }: { hist: HistoryPayload; events: SimulationEvent[]; dark: boolean }) {
  const colors = dark ? ['#3987e5', '#d95926', '#199e70'] : ['#2a78d6', '#eb6834', '#1baf7a'];
  const samples = hist.samples;
  const actions = events.filter((e) => e.kind === 'action' && /drug|fluid|blood|procedure|defib\.shock|airway\.intubated|oxygen/.test(e.code));
  if (samples.length < 2) return null;
  const W = 760;
  const H = 70;
  const t0 = samples[0]!.t;
  const t1 = Math.max(samples[samples.length - 1]!.t, t0 + 60);
  const x = (t: number) => 44 + ((t - t0) / (t1 - t0)) * (W - 52);
  return (
    <Card title="Course overview">
      <div className="flex flex-col gap-1">
        {VITAL_SERIES.map((s, i) => {
          const vals = samples.map((p) => p[s.key] as number);
          const lo = Math.min(...vals);
          const hi = Math.max(...vals, lo + 1);
          const y = (v: number) => 6 + (1 - (v - lo) / (hi - lo)) * (H - 12);
          const d = samples.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p[s.key] as number).toFixed(1)}`).join('');
          return (
            <svg key={s.key} viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`${s.label} over the case`}>
              <text x={0} y={16} fontSize="11" fill="var(--ink)" fontWeight={600}>
                {s.label}
              </text>
              <text x={0} y={30} fontSize="9.5" fill="var(--ink-3)" fontFamily="var(--font-mono)">
                {Math.round(lo)}–{Math.round(hi)}
              </text>
              {actions.map((a) => (
                <line key={a.id} x1={x(a.t)} x2={x(a.t)} y1={2} y2={H - 2} stroke="var(--line-strong)" strokeWidth={1} strokeDasharray="2 3" />
              ))}
              <path d={d} fill="none" stroke={colors[i]} strokeWidth={2} strokeLinejoin="round" />
            </svg>
          );
        })}
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
          <CircleDashed size={11} /> Dashed lines mark interventions ({actions.length}). Values are true simulated physiology, not just what was monitored.
        </div>
      </div>
    </Card>
  );
}
