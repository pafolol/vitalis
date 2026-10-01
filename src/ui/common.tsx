import clsx from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  icon,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; icon?: ReactNode }) {
  return (
    <button
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 select-none whitespace-nowrap',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'lg' && 'h-10 px-4 text-sm',
        variant === 'primary' && 'bg-accent text-accent-ink hover:brightness-110',
        variant === 'secondary' && 'bg-surface-3 text-ink hover:bg-surface-3/70 border border-line-strong',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-3 hover:text-ink',
        variant === 'subtle' && 'bg-accent-soft text-accent hover:bg-accent-soft/70',
        variant === 'danger' && 'bg-danger text-white hover:brightness-110',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'md',
  className,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={clsx('inline-flex rounded-md border border-line-strong bg-surface-2 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-[5px] font-medium transition-colors tabular',
            size === 'sm' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
            o.value === value ? 'bg-accent text-accent-ink shadow-sm' : 'text-ink-2 hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'danger' | 'warn' | 'good'; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
        tone === 'neutral' && 'bg-surface-3 text-ink-2',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'danger' && 'bg-danger-soft text-danger',
        tone === 'warn' && 'bg-warn-soft text-warn',
        tone === 'good' && 'bg-good-soft text-good',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Section({ title, children, action, className }: { title: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section className={clsx('border-b border-line px-4 py-3.5 last:border-b-0', className)}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

export const inputCls = 'h-8 w-full rounded-md border border-line-strong bg-surface-2 px-2.5 text-[13px] text-ink placeholder:text-ink-3 tabular';

export function ActionTile({ title, subtitle, onClick, active, disabled, icon, tone }: { title: string; subtitle?: string; onClick: () => void; active?: boolean; disabled?: boolean; icon?: ReactNode; tone?: 'danger' }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'group flex min-h-[52px] w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        active ? 'border-accent/60 bg-accent-soft' : 'border-line bg-surface-2 hover:border-line-strong hover:bg-surface-3',
        tone === 'danger' && !active && 'hover:border-danger/50',
      )}
    >
      {icon && <span className={clsx('mt-0.5 shrink-0', active ? 'text-accent' : 'text-ink-3 group-hover:text-ink-2')}>{icon}</span>}
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-tight text-ink">{title}</span>
        {subtitle && <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-3">{subtitle}</span>}
      </span>
    </button>
  );
}

export function SourceTag({ source }: { source: 'simulated' | 'derived' | 'authored' }) {
  const label = source === 'simulated' ? 'SIM' : source === 'derived' ? 'DER' : 'AUTH';
  const title =
    source === 'simulated'
      ? 'Computed from the simulated physiology'
      : source === 'derived'
        ? 'Derived from simulated state + scenario pathology type'
        : 'Authored by the scenario (not computed by the physiology engine)';
  return (
    <span title={title} className={clsx('rounded px-1 py-px font-mono text-[9px] font-semibold tracking-wider', source === 'authored' ? 'bg-warn-soft text-warn' : source === 'derived' ? 'bg-accent-soft text-accent' : 'bg-surface-3 text-ink-3')}>
      {label}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface-3 px-1 font-mono text-[10px] text-ink-2">{children}</kbd>;
}
