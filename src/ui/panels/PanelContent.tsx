import type { MutableRefObject } from 'react';
import type { PanelId } from '@/client/stores';
import type { AvatarVisualState } from '@/three/types';
import { AssessPanel } from './AssessPanel';
import { AirwayPanel } from './AirwayPanel';
import { CirculationPanel } from './CirculationPanel';
import { MedsPanel } from './MedsPanel';
import { ProceduresPanel } from './ProceduresPanel';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { TalkPanel } from './TalkPanel';
import { TimelinePanel } from './TimelinePanel';
import { AnatomyPanel } from './AnatomyPanel';
import { TrendsPanel } from './TrendsPanel';
import { InstructorPanel } from './InstructorPanel';

export function PanelContent({ panel }: { panel: PanelId; visual: MutableRefObject<AvatarVisualState> }) {
  switch (panel) {
    case 'assess':
      return <AssessPanel />;
    case 'airway':
      return <AirwayPanel />;
    case 'circulation':
      return <CirculationPanel />;
    case 'meds':
      return <MedsPanel />;
    case 'procedures':
      return <ProceduresPanel />;
    case 'diagnostics':
      return <DiagnosticsPanel />;
    case 'talk':
      return <TalkPanel />;
    case 'timeline':
      return <TimelinePanel />;
    case 'anatomy':
      return <AnatomyPanel />;
    case 'pharm':
      return <TrendsPanel />;
    case 'instructor':
      return <InstructorPanel />;
    default:
      return null;
  }
}
