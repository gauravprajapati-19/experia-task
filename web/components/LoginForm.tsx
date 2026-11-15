'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Store, UserRound } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button, Card, Field, Spinner, inputClass } from './ui';

const DEMO_ACCOUNTS = [
  { label: 'Merchant A', hint: 'Nova Retail', email: 'merchant.a@experia.test' },
  { label: 'Merchant B', hint: 'Orbit Foods', email: 'merchant.b@experia.test' },
  { label: 'Admin', hint: 'All merchants', email: 'admin@experia.test' },
];

// inlined by next.config.ts in development only (synthetic seed password, never real credentials)
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? '';

/** only same-site paths are accepted as a post-login destination (no open redirect) */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/dashboard';
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const passwordRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function fillDemo(demoEmail: string) {
    setEmail(demoEmail);
    setFieldErrors({});
    setFormError(null);
    if (DEMO_PASSWORD) setPassword(DEMO_PASSWORD);
    else passwordRef.current?.focus();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errors: typeof fieldErrors = {};
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) errors.email = 'Enter a valid email address.';
    if (!password) errors.password = 'Enter your password.';
    setFieldErrors(errors);
    setFormError(null);
    if (errors.email || errors.password) return;

    setSubmitting(true);
    try {
      const { user } = await api.login(email.trim(), password);
      queryClient.clear();
      queryClient.setQueryData(['me'], user);
      router.replace(safeNext(searchParams.get('next')));
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status === 429
          ? 'Too many sign-in attempts. Wait a minute and try again.'
          : err instanceof ApiError && err.status === 401
            ? 'Invalid email or password.'
            : err instanceof Error
              ? err.message
              : 'Sign-in failed. Try again.',
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="animate-fade-up w-full max-w-sm">
      <div className="mb-6 flex flex-col items-center gap-3 text-center">
        <span aria-hidden className="grid size-11 place-items-center rounded-xl bg-accent text-accent-ink shadow-sm">
          <Store className="size-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Merchant Console</h1>
          <p className="mt-1 text-sm text-muted">Sign in to see your payments.</p>
        </div>
      </div>

      <Card className="p-5 sm:p-6">
        <form onSubmit={submit} noValidate className="space-y-4">
          {formError && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
              <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              {formError}
            </p>
          )}
          <Field label="Email" id="email" error={fieldErrors.email}>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={Boolean(fieldErrors.email)}
              aria-describedby={fieldErrors.email ? 'email-error' : undefined}
              className={inputClass(Boolean(fieldErrors.email))}
            />
          </Field>
          <Field label="Password" id="password" error={fieldErrors.password}>
            <input
              id="password"
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(fieldErrors.password)}
              aria-describedby={fieldErrors.password ? 'password-error' : undefined}
              className={inputClass(Boolean(fieldErrors.password))}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={submitting} className="w-full">
            {submitting && <Spinner />}
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>

      <div className="mt-6">
        <p className="mb-2 text-center text-xs font-medium tracking-wide text-muted uppercase">Use a demo account</p>
        <div className="grid grid-cols-3 gap-2">
          {DEMO_ACCOUNTS.map((account) => (
            <button
              key={account.email}
              type="button"
              onClick={() => fillDemo(account.email)}
              className="flex flex-col items-center gap-1 rounded-lg border border-line bg-surface px-2 py-2.5 text-center transition-colors hover:border-accent hover:bg-accent-soft"
            >
              <UserRound aria-hidden className="size-4 text-muted" />
              <span className="text-sm font-medium">{account.label}</span>
              <span className="text-xs text-muted">{account.hint}</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-center text-xs text-muted">
          Synthetic demo users only. {DEMO_PASSWORD ? 'The buttons fill both fields.' : 'Enter the demo password from your .env.'}
        </p>
      </div>
    </div>
  );
}
