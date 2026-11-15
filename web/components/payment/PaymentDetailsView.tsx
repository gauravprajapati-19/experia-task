'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, FileQuestion } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ApiError, api, type PaymentDetails } from '@/lib/api';
import { formatDateTime, formatPaise } from '@/lib/format';
import { useMe, useMerchants } from '@/lib/hooks';
import { Card, EmptyState, ErrorState, Skeleton, StatusBadge, buttonClass } from '../ui';
import { AuditTimeline } from './AuditTimeline';
import { CopyButton } from './CopyButton';
import { WebhookEvents } from './WebhookEvents';

export function PaymentDetailsView({ id }: { id: string }) {
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const merchants = useMerchants(isAdmin);
  const details = useQuery({ queryKey: ['payment', id], queryFn: () => api.payment(id) });

  const back = (
    <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
      <ArrowLeft aria-hidden className="size-4" /> All payments
    </Link>
  );

  if (details.isPending) return <DetailsSkeleton back={back} />;

  if (details.isError) {
    // 404 covers both "no such payment" and "another merchant's payment": the API never says which
    const notFound = details.error instanceof ApiError && details.error.status === 404;
    return (
      <div className="space-y-4">
        {back}
        <Card>
          {notFound ? (
            <EmptyState
              icon={<FileQuestion aria-hidden className="size-5" />}
              title="Payment not found"
              message="This payment does not exist, or it is not available to your account."
              action={
                <Link href="/dashboard" className={buttonClass('secondary')}>
                  Back to payments
                </Link>
              }
            />
          ) : (
            <ErrorState title="Could not load this payment" message={details.error.message} onRetry={() => void details.refetch()} />
          )}
        </Card>
      </div>
    );
  }

  const { payment, auditTimeline, webhookEvents } = details.data;
  const merchantName = merchants.data?.find((m) => m.id === payment.merchantId)?.name;

  return (
    <div className="space-y-6">
      {back}

      <header className="animate-fade-up flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h1 className="truncate font-mono text-lg font-semibold sm:text-xl">{payment.reference}</h1>
            <CopyButton value={payment.reference} label="Copy reference" />
          </div>
          <p className="mt-1 text-sm text-muted">
            Created {formatDateTime(payment.createdAt)}
            {isAdmin && merchantName ? ` · ${merchantName}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">
          <p className="text-3xl font-semibold tracking-tight tabular-nums">{formatPaise(payment.amountPaise)}</p>
          <StatusBadge status={payment.status} className="text-sm" />
        </div>
      </header>

      {payment.needsReconciliation && <ReconciliationBanner details={details.data} />}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold">Details</h2>
          <dl className="mt-3 divide-y divide-line text-sm">
            <Row label="Status">
              <StatusBadge status={payment.status} />
            </Row>
            <Row label="Amount">
              <span className="tabular-nums">
                {formatPaise(payment.amountPaise)} <span className="text-muted">({payment.amountPaise.toLocaleString('en-IN')} paise)</span>
              </span>
            </Row>
            <Row label="Reference" mono copy={payment.reference}>
              {payment.reference}
            </Row>
            <Row label="Provider ID" mono copy={payment.providerPaymentId ?? undefined}>
              {payment.providerPaymentId ?? <span className="font-sans text-muted">Not assigned yet</span>}
            </Row>
            <Row label="Payment ID" mono copy={payment.id}>
              {payment.id}
            </Row>
            {isAdmin && <Row label="Merchant">{merchantName ?? payment.merchantId}</Row>}
            <Row label="Description">{payment.description ?? <span className="text-muted">None</span>}</Row>
            <Row label="Customer">{payment.customerEmail ?? <span className="text-muted">None</span>}</Row>
            <Row label="Reconciliation">
              {payment.needsReconciliation ? (
                <span className="text-amber-800 dark:text-amber-300">Needs review</span>
              ) : (
                <span className="text-muted">Not needed</span>
              )}
            </Row>
            <Row label="Last updated">
              <span className="tabular-nums">{formatDateTime(payment.updatedAt, true)}</span>
            </Row>
          </dl>
        </Card>

        <Card className="p-5 lg:col-span-3">
          <h2 className="text-sm font-semibold">Audit timeline</h2>
          <p className="mt-0.5 text-xs text-muted">Every status change, from an append-only log.</p>
          <AuditTimeline entries={auditTimeline} />
        </Card>
      </div>

      <WebhookEvents events={webhookEvents} />
    </div>
  );
}

/** explains why the payment is flagged, using the most specific fact available */
function ReconciliationBanner({ details }: { details: PaymentDetails }) {
  const { payment, webhookEvents } = details;
  const conflict = [...webhookEvents].reverse().find((e) => e.outcome === 'invalid_transition');

  let reason: ReactNode;
  if (conflict) {
    reason = (
      <>
        A <strong>{conflict.status}</strong> webhook arrived after the payment was already <strong>{payment.status}</strong> (event{' '}
        <span className="font-mono break-all">{conflict.eventId}</span>). It was stored but not applied.
      </>
    );
  } else if (payment.lastProviderError) {
    reason = (
      <>
        The provider call did not complete: <span className="font-mono break-all">{payment.lastProviderError}</span>. The outcome is unknown, so it stays
        Pending rather than Failed.
      </>
    );
  } else {
    reason = 'Our status and the provider’s did not match during reconciliation. It is reported for review and was not overwritten.';
  }

  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-200"
    >
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">Needs reconciliation</p>
        <p className="mt-0.5">{reason}</p>
      </div>
    </div>
  );
}

function Row({ label, mono, copy, children }: { label: string; mono?: boolean; copy?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-3 py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className={`flex min-w-0 items-center gap-1 ${mono ? 'font-mono text-xs' : ''}`}>
        <span className="min-w-0 break-all">{children}</span>
        {copy && <CopyButton value={copy} label={`Copy ${label.toLowerCase()}`} />}
      </dd>
    </div>
  );
}

function DetailsSkeleton({ back }: { back: ReactNode }) {
  return (
    <div className="space-y-6" role="status" aria-label="Loading payment">
      {back}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-6 w-72 max-w-full" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="grid gap-6 lg:grid-cols-5">
        <Skeleton className="h-80 rounded-xl lg:col-span-2" />
        <Skeleton className="h-80 rounded-xl lg:col-span-3" />
      </div>
      <Skeleton className="h-48 rounded-xl" />
    </div>
  );
}
