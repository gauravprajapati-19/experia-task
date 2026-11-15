'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, type Payment } from '@/lib/api';
import { rupeesToPaise } from '@/lib/format';
import { Button, Field, Spinner, inputClass } from '../ui';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (payment: Payment) => void;
}

const EMPTY_FORM = { amount: '', description: '', customerEmail: '' };

export function CreatePaymentDialog({ open, onClose, onCreated }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof EMPTY_FORM, string>>>({});
  // one key per distinct submission: a retry of the same form after a network error reuses it
  // (the API replays the original payment), while editing the form starts a new payment.
  const idempotencyKey = useRef('');

  const create = useMutation({
    mutationFn: (input: { amountPaise: number; description?: string; customerEmail?: string }) => api.createPayment(input, idempotencyKey.current),
    onSuccess: async (payment) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['payments'] }),
        queryClient.invalidateQueries({ queryKey: ['summary'] }),
      ]);
      onCreated(payment);
    },
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setForm(EMPTY_FORM);
      setErrors({});
      create.reset();
      idempotencyKey.current = crypto.randomUUID();
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
    // `create` is stable enough here; we only react to the open flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function update(field: keyof typeof EMPTY_FORM, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
    idempotencyKey.current = crypto.randomUUID();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const amount = rupeesToPaise(form.amount);
    const nextErrors: typeof errors = {};
    if ('error' in amount) nextErrors.amount = amount.error;
    if (form.description.trim().length > 140) nextErrors.description = 'Keep the description to 140 characters.';
    if (form.customerEmail.trim() && !/^\S+@\S+\.\S+$/.test(form.customerEmail.trim())) nextErrors.customerEmail = 'Enter a valid email address.';
    setErrors(nextErrors);
    if ('error' in amount || Object.keys(nextErrors).length > 0) return;

    create.mutate({
      amountPaise: amount.paise,
      description: form.description.trim() || undefined,
      customerEmail: form.customerEmail.trim() || undefined,
    });
  }

  const apiError = create.error instanceof ApiError ? create.error : null;

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby="create-payment-title"
      className="animate-fade-up m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-line bg-surface p-0 text-ink shadow-xl"
    >
      <form onSubmit={submit} noValidate>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id="create-payment-title" className="text-base font-semibold">
              Create test payment
            </h2>
            <p className="mt-0.5 text-sm text-muted">Simulated only. No real money moves.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink">
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {create.isError && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
              <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                {apiError?.status === 0 ? `${apiError.message} Submitting again is safe: it will not create a duplicate.` : create.error.message}
              </span>
            </p>
          )}
          <Field label="Amount (₹)" id="amount" error={errors.amount} hint="Up to ₹1 crore, at most 2 decimal places.">
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted">
                ₹
              </span>
              <input
                id="amount"
                inputMode="decimal"
                autoComplete="off"
                autoFocus
                placeholder="1,250.00"
                value={form.amount}
                onChange={(e) => update('amount', e.target.value)}
                aria-invalid={Boolean(errors.amount)}
                aria-describedby={errors.amount ? 'amount-error' : 'amount-hint'}
                className={`${inputClass(Boolean(errors.amount))} pl-7 tabular-nums`}
              />
            </div>
          </Field>
          <Field label="Description (optional)" id="description" error={errors.description}>
            <input
              id="description"
              maxLength={140}
              placeholder="Order #1042"
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? 'description-error' : undefined}
              className={inputClass(Boolean(errors.description))}
            />
          </Field>
          <Field label="Customer email (optional)" id="customerEmail" error={errors.customerEmail}>
            <input
              id="customerEmail"
              type="email"
              placeholder="customer@example.test"
              value={form.customerEmail}
              onChange={(e) => update('customerEmail', e.target.value)}
              aria-invalid={Boolean(errors.customerEmail)}
              aria-describedby={errors.customerEmail ? 'customerEmail-error' : undefined}
              className={inputClass(Boolean(errors.customerEmail))}
            />
          </Field>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-3 sm:flex-row sm:justify-end">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending && <Spinner />}
            {create.isPending ? 'Creating…' : 'Create payment'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
