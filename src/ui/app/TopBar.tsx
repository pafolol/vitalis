import { useState } from 'react';
import clsx from 'clsx';
import { AlertTriangle, FastForward, Flag, Monitor as MonitorIcon, Moon, Pause, Save, Sun } from 'lucide-react';
import { useCase, useUi } from '@/client/stores';
import { simClient } from '@/client/simClient';
import { formatClock } from '@/sim/core/math';
import { Badge, Button, Segmented } from '../common';
import { Logo } from './StartScreen';

const SPEEDS = [0, 1, 2, 5, 10];

export function TopBar({ onEnd, monitorOpen, onToggleMonitor }: { onEnd: () => void; monitorOpen: boolean; onToggleMonitor: () => void }) {
  const meta = useCase((s) => s.meta);
  const t = useCase((s) => s.snapshot?.t ?? 0);
  const status = useCase((s) => s.snapshot?.status);
  const speed = useCase((s) => s.speed);
  const setSpeed = useCase((s) => s.setSpeed);
  const save = useCase((s) => s.save);
  const toast = useCase((s) => s.toast);
  const { theme, setTheme } = useUi();
  const [saving, setSaving] = useState(false);
  if (!meta) return null;
  const p = meta.patient;
  const allergies = p.allergies.length ? p.allergies.map((a) => a.agent).join(', ') : null;

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line bg-surface px-3" data-testid="topbar">
      <Logo size={26} />
      <div className="hidden text-[13px] font-semibold tracking-tight md:block">Vitalis</div>
      <div className="mx-1 h-6 w-px bg-line" />
      <div className="min-w-0 leading-tight" data-testid="patient-chip">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold">{p.name}</span>
          <span className="text-[12px] text-ink-2 tabular">
            {meta.patient.name.startsWith('Unknown') ? `~${Math.round(p.ageYears / 5) * 5}` : p.ageYears}y · {p.sex === 'male' ? 'M' : 'F'} · ~{Math.round(p.weightKg / 5) * 5} kg
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
          <span className="truncate">{meta.chiefComplaint}</span>
          <span>·</span>
          <span className="font-mono">seed {meta.seed}</span>
        </div>
      </div>
      {allergies && !p.name.startsWith('Unknown') && (
        <Badge tone="danger" className="hidden lg:inline-flex" data-testid="allergy-badge">
          <AlertTriangle size={11} /> Allergy: {allergies}
        </Badge>
      )}
      {status && !status.alive && <Badge tone="danger">Patient died</Badge>}
      {status?.phase === 'ended' && <Badge>Case ended</Badge>}

      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1" data-testid="sim-clock">
          <span className={clsx('h-2 w-2 rounded-full', speed === 0 ? 'bg-warn' : 'bg-good pulse-dot')} />
          <span className="font-mono text-[15px] font-medium tabular">{formatClock(t)}</span>
        </div>
        <Segmented
          ariaLabel="Simulation speed"
          value={speed}
          onChange={setSpeed}
          options={SPEEDS.map((s) => ({ value: s, label: s === 0 ? <Pause size={12} className="inline" /> : `${s}×`, title: s === 0 ? 'Pause' : `${s}× real time` }))}
        />
        <Button variant="ghost" size="sm" title="Skip ahead 5 simulated minutes" onClick={() => simClient().skip(300)} icon={<FastForward size={14} />} className="hidden xl:inline-flex">
          +5 min
        </Button>
        <div className="mx-1 h-6 w-px bg-line" />
        <Button
          variant="ghost"
          size="sm"
          icon={<Save size={14} />}
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await save();
            setSaving(false);
            toast('Case saved locally — resume it from the start screen', 'good');
          }}
          data-testid="save-case"
        >
          <span className="hidden lg:inline">Save</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="Toggle theme">
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </Button>
        <Button variant="ghost" size="sm" onClick={onToggleMonitor} title={monitorOpen ? 'Hide monitor' : 'Show monitor'} className={clsx(!monitorOpen && 'text-accent')}>
          <MonitorIcon size={14} />
        </Button>
        <Button variant="primary" size="sm" icon={<Flag size={13} />} onClick={onEnd} data-testid="end-case">
          End case
        </Button>
      </div>
    </header>
  );
}
