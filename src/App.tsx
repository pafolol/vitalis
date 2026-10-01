import { lazy, Suspense, useEffect } from 'react';
import { tryResumeLast, useCase, useUi, wireSimulation } from '@/client/stores';
import { StartScreen } from '@/ui/app/StartScreen';
import { Handoff } from '@/ui/app/Handoff';
import { Toasts } from '@/ui/app/Toasts';

const CaseScreen = lazy(() => import('@/ui/app/CaseScreen'));
const Debrief = lazy(() => import('@/ui/debrief/Debrief'));

export default function App() {
  const screen = useCase((s) => s.screen);
  const theme = useUi((s) => s.theme);

  useEffect(() => {
    wireSimulation();
    // A browser reload resumes the case that was open (paused), from local persistence
    void tryResumeLast();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="h-full w-full">
      {screen === 'start' && <StartScreen />}
      {screen === 'loading' && <Loading />}
      <Suspense fallback={<Loading />}>
        {(screen === 'handoff' || screen === 'case') && <CaseScreen />}
        {screen === 'debrief' && <Debrief />}
      </Suspense>
      {screen === 'handoff' && <Handoff />}
      <Toasts />
    </div>
  );
}

function Loading() {
  return (
    <div className="grid h-full place-items-center" data-testid="loading">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
        <div className="text-sm text-ink-2">Simulating the patient's course before arrival…</div>
      </div>
    </div>
  );
}
