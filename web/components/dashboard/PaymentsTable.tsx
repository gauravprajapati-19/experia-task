import type { UseQueryResult } from '@tanstack/react-query';
import { AlertTriangle, Plus, ReceiptText, SearchX } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Payment, PaymentPage } from '@/lib/api';
import { formatDateTime, formatPaise } from '@/lib/format';
import { Button, Card, EmptyState, ErrorState, Skeleton, StatusBadge, cx } from '../ui';

interface Props {
  query: UseQueryResult<PaymentPage>;
  showMerchant: boolean;
  merchantName: (id: string) => string | undefined;
  hasFilters: boolean;
  canCreate: boolean;
  onCreate: () => void;
  onClearFilters: () => void;
}

export function PaymentsTable({ query, showMerchant, merchantName, hasFilters, canCreate, onCreate, onClearFilters }: Props) {
  const router = useRouter();

  if (query.isPending) return <TableSkeleton />;
  if (query.isError) {
    return (
      <Card>
        <ErrorState title="Could not load payments" message={query.error.message} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const { items } = query.data;
  if (items.length === 0) {
    return (
      <Card>
        {hasFilters ? (
          <EmptyState
            icon={<SearchX aria-hidden className="size-5" />}
            title="No payments match these filters"
            message="Try a different reference or status."
            action={<Button onClick={onClearFilters}>Clear filters</Button>}
          />
        ) : (
          <EmptyState
            icon={<ReceiptText aria-hidden className="size-5" />}
            title="No payments yet"
            message={canCreate ? 'Create a test payment to see it here.' : 'Payments will appear here once this merchant creates them.'}
            action={
              canCreate ? (
                <Button variant="primary" onClick={onCreate}>
                  <Plus aria-hidden className="size-4" /> Create test payment
                </Button>
              ) : undefined
            }
          />
        )}
      </Card>
    );
  }

  return (
    <Card className={cx('overflow-hidden transition-opacity', query.isPlaceholderData && 'opacity-60')}>
      <table className="hidden w-full text-sm sm:table">
        <thead className="border-b border-line bg-surface-2/60 text-left text-xs font-medium tracking-wide text-muted uppercase">
          <tr>
            <th scope="col" className="px-4 py-2.5">Reference</th>
            {showMerchant && <th scope="col" className="px-4 py-2.5">Merchant</th>}
            <th scope="col" className="px-4 py-2.5 text-right">Amount</th>
            <th scope="col" className="px-4 py-2.5">Status</th>
            <th scope="col" className="px-4 py-2.5">Created</th>
            <th scope="col" className="hidden px-4 py-2.5 lg:table-cell">Provider ID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((p) => (
            <tr key={p.id} onClick={() => router.push(`/payments/${p.id}`)} className="cursor-pointer transition-colors hover:bg-surface-2/70">
              <td className="px-4 py-3">
                <Link href={`/payments/${p.id}`} onClick={(e) => e.stopPropagation()} className="font-mono text-[13px] font-medium hover:text-accent hover:underline">
                  {p.reference}
                </Link>
                <ReconcileHint payment={p} />
              </td>
              {showMerchant && <td className="px-4 py-3 text-muted">{merchantName(p.merchantId) ?? '—'}</td>}
              <td className="px-4 py-3 text-right font-medium tabular-nums">{formatPaise(p.amountPaise)}</td>
              <td className="px-4 py-3">
                <StatusBadge status={p.status} />
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-muted tabular-nums">{formatDateTime(p.createdAt)}</td>
              <td className="hidden max-w-48 truncate px-4 py-3 font-mono text-xs text-muted lg:table-cell">{p.providerPaymentId ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* under 640px: stacked cards */}
      <ul className="divide-y divide-line sm:hidden">
        {items.map((p) => (
          <li key={p.id}>
            <Link href={`/payments/${p.id}`} className="block px-4 py-3 transition-colors hover:bg-surface-2/70">
              <div className="flex items-center justify-between gap-3">
                <span className="text-base font-semibold tabular-nums">{formatPaise(p.amountPaise)}</span>
                <StatusBadge status={p.status} />
              </div>
              <p className="mt-1 truncate font-mono text-xs">{p.reference}</p>
              <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                <span className="tabular-nums">{formatDateTime(p.createdAt)}</span>
                {showMerchant && <span>· {merchantName(p.merchantId)}</span>}
              </p>
              <ReconcileHint payment={p} />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ReconcileHint({ payment }: { payment: Payment }) {
  if (!payment.needsReconciliation) return null;
  return (
    <span className="mt-1 flex items-center gap-1 text-xs text-amber-800 dark:text-amber-300">
      <AlertTriangle aria-hidden className="size-3.5" /> Needs reconciliation
    </span>
  );
}

function TableSkeleton() {
  return (
    <div role="status" aria-label="Loading payments" className="divide-y divide-line rounded-xl border border-line bg-surface">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-20" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="hidden h-4 w-28 sm:block" />
        </div>
      ))}
    </div>
  );
}
