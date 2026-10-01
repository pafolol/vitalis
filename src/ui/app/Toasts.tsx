import clsx from 'clsx';
import { X } from 'lucide-react';
import { useCase } from '@/client/stores';

export function Toasts() {
  const toasts = useCase((s) => s.toasts);
  const dismiss = useCase((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'fade-in-up pointer-events-auto flex max-w-md items-start gap-2 rounded-lg border px-3 py-2 text-[13px] shadow-lg backdrop-blur',
            t.tone === 'error' && 'border-danger/40 bg-danger-soft text-ink',
            t.tone === 'warning' && 'border-warn/40 bg-surface text-ink',
            t.tone === 'good' && 'border-good/40 bg-surface text-ink',
            t.tone === 'info' && 'border-line-strong bg-surface text-ink',
          )}
        >
          <span className="leading-snug">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="text-ink-3 hover:text-ink">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
