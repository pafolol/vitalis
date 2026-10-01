import { Droplets, HeartPulse, Syringe, Wind, Zap, Timer } from 'lucide-react';
import { useCase } from '@/client/stores';
import { formatClock } from '@/sim/core/math';

const O2_LABEL: Record<string, string> = {
  nasalCannula: 'Nasal cannula',
  simpleMask: 'Face mask',
  nonRebreather: 'Non-rebreather',
  highFlowNasal: 'High-flow nasal',
};

/** Always-visible summary of what is currently being done to the patient. */
export function TherapyStrip() {
  const snap = useCase((s) => s.snapshot);
  if (!snap) return null;
  const th = snap.therapy;
  const chips: { key: string; icon: typeof Wind; text: string; tone?: 'danger' | 'accent' }[] = [];
  if (th.ventilator.on) chips.push({ key: 'vent', icon: Wind, text: `Ventilator Vt ${th.ventilator.vt} · RR ${th.ventilator.rr} · PEEP ${th.ventilator.peep} · FiO₂ ${Math.round(th.ventilator.fio2 * 100)}%`, tone: 'accent' });
  else if (th.bvm.active) chips.push({ key: 'bvm', icon: Wind, text: `BVM ${th.bvm.rate}/min`, tone: 'accent' });
  else if (th.oxygen.device !== 'none') chips.push({ key: 'o2', icon: Wind, text: `${O2_LABEL[th.oxygen.device] ?? th.oxygen.device} ${th.oxygen.flowLpm} L/min${th.oxygen.device === 'highFlowNasal' ? ` · ${Math.round(th.oxygen.fio2Set * 100)}%` : ''}` });
  if (th.airway.ett) chips.push({ key: 'ett', icon: Wind, text: 'ETT' });
  if (th.cpr.active) chips.push({ key: 'cpr', icon: HeartPulse, text: `CPR ${th.cpr.mode === 'mechanical' ? '(device)' : `${Math.round(th.cpr.rate)}/min · quality ${Math.round(th.cpr.quality * 100)}%`}`, tone: 'danger' });
  if (th.defib.pacing.on) chips.push({ key: 'pace', icon: Zap, text: `Pacing ${th.defib.pacing.rate}/min ${th.defib.pacing.mA} mA` });
  for (const inf of th.infusions.filter((i) => i.stoppedAt === null)) {
    chips.push({
      key: inf.id,
      icon: inf.kind === 'drug' ? Syringe : Droplets,
      text: inf.kind === 'drug' ? `${inf.label.replace(' infusion', '')} ${inf.rate} ${inf.rateUnit}` : `${inf.label.replace(/ \d+ mL$/, '')} ${Math.round(inf.infusedMl)}/${Math.round(inf.totalMl)} mL`,
    });
  }
  if (th.procedures.tourniquet) chips.push({ key: 'tq', icon: HeartPulse, text: 'Tourniquet' });
  for (const p of snap.derived.pending) chips.push({ key: `p${p.kind}${p.completesAt}`, icon: Timer, text: `${p.kind === 'ivAccess' ? 'Access attempt' : p.kind === 'intubation' ? 'Airway procedure' : p.kind === 'chestTube' ? 'Chest drain' : 'Arterial line'} · ${formatClock(Math.max(0, p.completesAt - snap.t))}` });
  if (chips.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-wrap justify-center gap-1.5" data-testid="therapy-strip">
      {chips.map((c) => (
        <span key={c.key} className={`pointer-events-auto inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] font-medium backdrop-blur-md ${c.tone === 'danger' ? 'border-red-400/40 bg-red-500/20 text-red-100' : c.tone === 'accent' ? 'border-cyan-300/30 bg-cyan-500/15 text-cyan-50' : 'border-white/10 bg-black/45 text-white/85'}`}>
          <c.icon size={12} />
          {c.text}
        </span>
      ))}
    </div>
  );
}
