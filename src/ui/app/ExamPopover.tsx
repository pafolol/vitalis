import { useEffect, useMemo } from 'react';
import clsx from 'clsx';
import { Headphones, X } from 'lucide-react';
import type { BodyPointerHit, BodyRegion } from '@/three/types';
import type { Tool } from '@/client/stores';
import { useCase, useUi } from '@/client/stores';
import { auscultate, examine, type ExamKind, type Finding } from '@/sim/exam/findings';
import { simClient } from '@/client/simClient';
import { audio } from '../audio';
import { SourceTag } from '../common';

export interface ExamPopoverState {
  hit: BodyPointerHit;
  tool: Tool;
}

const ZONE_LABEL: Record<string, string> = {
  trachea: 'Trachea / neck',
  rightUpperChest: 'Right upper chest',
  leftUpperChest: 'Left upper chest',
  rightLowerChest: 'Right lower chest',
  leftLowerChest: 'Left lower chest',
  rightAxilla: 'Right axilla',
  leftAxilla: 'Left axilla',
  aorticArea: 'Aortic area',
  pulmonicArea: 'Pulmonic area',
  tricuspidArea: 'Tricuspid area',
  mitralArea: 'Apex (mitral area)',
  epigastrium: 'Epigastrium',
  rightUpperQuadrant: 'Right upper quadrant',
  leftUpperQuadrant: 'Left upper quadrant',
  rightLowerQuadrant: 'Right lower quadrant',
  leftLowerQuadrant: 'Left lower quadrant',
  rightRadial: 'Right radial pulse',
  leftRadial: 'Left radial pulse',
  rightCarotid: 'Right carotid',
  leftCarotid: 'Left carotid',
  rightFemoral: 'Right femoral',
  leftFemoral: 'Left femoral',
  rightSecondICS: 'Right 2nd ICS',
  leftSecondICS: 'Left 2nd ICS',
  rightFifthICSAxillary: 'Right 5th ICS (axillary)',
  leftFifthICSAxillary: 'Left 5th ICS (axillary)',
};

function kindsFor(tool: Tool, region: BodyRegion, zone: string | null): ExamKind[] {
  if (tool === 'stethoscope') return ['auscultation'];
  if (tool === 'palpate') {
    if (zone && /Radial|Carotid|Femoral/.test(zone)) return ['pulses'];
    if (region === 'abdomen' || region === 'pelvis') return ['abdomen'];
    if (region === 'chest') return ['percussion', 'breathing'];
    if (region === 'head' || region === 'face') return ['skin'];
    return ['pulses', 'skin'];
  }
  // inspect
  if (region === 'head' || region === 'face') return ['general', 'pupils', 'airway'];
  if (region === 'neck') return ['airway', 'circulation'];
  if (region === 'chest' || region === 'back') return ['breathing'];
  if (region === 'abdomen' || region === 'pelvis') return ['abdomen'];
  return ['limbs', 'skin'];
}

export function ExamPopover({ state, onClose }: { state: ExamPopoverState; onClose: () => void }) {
  const meta = useCase((s) => s.meta);
  const snapshot = useCase((s) => s.snapshot);
  const dispatch = useCase((s) => s.dispatch);
  const audioEnabled = useUi((s) => s.audioEnabled);
  const { hit, tool } = state;
  const zone = hit.zone ?? (hit.region === 'chest' ? 'rightUpperChest' : hit.region === 'abdomen' ? 'epigastrium' : hit.region === 'neck' ? 'trachea' : null);
  const scenario = meta?.scenario ?? null;

  const findings: Finding[] = useMemo(() => {
    if (!snapshot || !scenario) return [];
    const kinds = kindsFor(tool, hit.region, zone);
    return kinds.flatMap((k) => examine(snapshot, scenario, k, zone ?? undefined));
  }, [snapshot, scenario, tool, hit.region, zone]);

  // Log the examination once when opened
  useEffect(() => {
    const kinds = kindsFor(tool, hit.region, zone);
    dispatch({ type: 'exam.perform', exam: kinds.join('+'), zone: zone ?? hit.region, detail: findings[0]?.text?.slice(0, 160) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  // Auscultation audio
  useEffect(() => {
    if (tool !== 'stethoscope' || !zone) return;
    const snap = simClient().latest;
    if (!snap || !audioEnabled) return;
    audio.startAuscultation(auscultate(snap, zone));
    const id = setInterval(() => {
      const s = simClient().latest;
      if (s) audio.updateAuscultation(auscultate(s, zone));
    }, 250);
    return () => {
      clearInterval(id);
      audio.stopAuscultation();
    };
  }, [tool, zone, audioEnabled]);

  const [x, y] = hit.screen;
  const title = tool === 'stethoscope' ? 'Auscultation' : tool === 'palpate' ? 'Palpation' : 'Inspection';
  return (
    <div
      className="fade-in-up absolute z-30 w-[320px] rounded-xl border border-line-strong bg-surface/95 shadow-2xl backdrop-blur"
      style={{ left: Math.min(Math.max(8, x + 14), window.innerWidth - 340), top: Math.max(8, y - 40) }}
      data-testid="exam-popover"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[13px] font-semibold">{title}</span>
        <span className="truncate text-[12px] text-ink-3">{zone ? ZONE_LABEL[zone] ?? zone : hit.region}</span>
        <button className="ml-auto text-ink-3 hover:text-ink" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </div>
      <ul className="flex flex-col gap-1.5 px-3 py-2.5">
        {findings.map((f, i) => (
          <li key={i} className="text-[12.5px] leading-snug">
            <div className="flex items-center gap-1.5">
              <span className={clsx('text-[11px] font-semibold uppercase tracking-wide', f.abnormal ? 'text-warn' : 'text-ink-3')}>{f.label}</span>
              <SourceTag source={f.source} />
            </div>
            <div className="text-ink">{f.text}</div>
          </li>
        ))}
      </ul>
      {tool === 'stethoscope' && (
        <div className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-[11px] text-ink-3">
          <Headphones size={12} />
          {audioEnabled ? 'Listening — synthesised from the simulated breathing and heart cycle.' : 'Enable monitor audio (speaker icon) to hear the chest.'}
        </div>
      )}
    </div>
  );
}

