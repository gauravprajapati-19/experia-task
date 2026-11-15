import { AlertCircle, RotateCw } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { PaymentStatus } from '@/lib/api';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost';

const buttonStyles: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover shadow-sm',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-2',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink',
};

export function buttonClass(variant: ButtonVariant = 'secondary', extra?: string): string {
  return cx(
    'inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-sm font-medium whitespace-nowrap',
    'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
    buttonStyles[variant],
    extra,
  );
}

export function Button({
  variant = 'secondary',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cx('rounded-xl border border-line bg-surface shadow-xs', className)}>{children}</section>;
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-md bg-surface-2', className)} />;
}

// colour is never the only signal: every badge carries its text label, so it still reads in greyscale
const statusStyles: Record<PaymentStatus, { badge: string; dot: string; label: string }> = {
  SUCCESS: {
    badge: 'bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-500/10 dark:text-green-300 dark:ring-green-400/30',
    dot: 'bg-green-600 dark:bg-green-400',
    label: 'Success',
  },
  PENDING: {
    badge: 'bg-amber-50 text-amber-800 ring-amber-600/25 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/30',
    dot: 'bg-amber-500 dark:bg-amber-400',
    label: 'Pending',
  },
  FAILED: {
    badge: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/30',
    dot: 'bg-red-600 dark:bg-red-400',
    label: 'Failed',
  },
};

export function StatusBadge({ status, className }: { status: PaymentStatus; className?: string }) {
  const style = statusStyles[status];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        style.badge,
        className,
      )}
    >
      <span aria-hidden className={cx('size-1.5 rounded-full', style.dot)} />
      {style.label}
    </span>
  );
}

export function ErrorState({ title = 'Something went wrong', message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <AlertCircle aria-hidden className="size-8 text-red-600 dark:text-red-400" />
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted">{message}</p>
      </div>
      {onRetry && (
        <Button onClick={onRetry}>
          <RotateCw aria-hidden className="size-4" /> Retry
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, message, action }: { icon: ReactNode; title: string; message: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="grid size-11 place-items-center rounded-full bg-accent-soft text-accent">{icon}</div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      </div>
      {action}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <RotateCw aria-hidden className={cx('size-4 animate-spin', className)} />;
}

export function inputClass(invalid: boolean): string {
  return cx(
    'h-10 w-full rounded-lg border bg-surface px-3 text-sm text-ink placeholder:text-muted/70',
    invalid ? 'border-red-500 dark:border-red-400' : 'border-line',
  );
}

export function Field({ label, id, error, hint, children }: { label: string; id: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
