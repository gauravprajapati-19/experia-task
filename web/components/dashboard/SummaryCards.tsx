import type { UseQueryResult } from '@tanstack/react-query';
import { CheckCircle2, Clock3, IndianRupee, ReceiptText, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { PaymentSummary } from '@/lib/api';
import { formatPaise, plural } from '@/lib/format';
import { Card, ErrorState, Skeleton, cx } from '../ui';

export function SummaryCards({ query }: { query: UseQueryResult<PaymentSummary> }) {
  if (query.isError) {
    return (
      <Card>
        <ErrorState title="Could not load totals" message={query.error.message} onRetry={() => void query.refetch()} />
      </Card>
    );
  }

  const s = query.data;
  const cards: { label: string; icon: ReactNode; value?: string; detail?: string; tone: string }[] = [
    { label: 'Total payments', icon: <ReceiptText />, value: s && String(s.totalCount), detail: s && `${formatPaise(s.totalAmountPaise)} in total`, tone: 'text-accent bg-accent-soft' },
    { label: 'Total volume', icon: <IndianRupee />, value: s && formatPaise(s.totalAmountPaise), detail: s && `across ${plural(s.totalCount, 'payment')}`, tone: 'text-accent bg-accent-soft' },
    {
      label: 'Success',
      icon: <CheckCircle2 />,
      value: s && String(s.byStatus.SUCCESS.count),
      detail: s && formatPaise(s.byStatus.SUCCESS.amountPaise),
      tone: 'text-green-700 bg-green-50 dark:text-green-300 dark:bg-green-500/10',
    },
    {
      label: 'Pending',
      icon: <Clock3 />,
      value: s && String(s.byStatus.PENDING.count),
      detail: s && formatPaise(s.byStatus.PENDING.amountPaise),
      tone: 'text-amber-800 bg-amber-50 dark:text-amber-300 dark:bg-amber-500/10',
    },
    {
      label: 'Failed',
      icon: <XCircle />,
      value: s && String(s.byStatus.FAILED.count),
      detail: s && formatPaise(s.byStatus.FAILED.amountPaise),
      tone: 'text-red-700 bg-red-50 dark:text-red-300 dark:bg-red-500/10',
    },
  ];

  return (
    <ul className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5" aria-busy={query.isPending}>
      {cards.map((card, i) => (
        <li
          key={card.label}
          className={cx('animate-fade-up rounded-xl border border-line bg-surface p-4 shadow-xs', i === 0 && 'min-[480px]:max-md:col-span-2')}
          style={{ animationDelay: `${i * 40}ms` }}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-muted">{card.label}</p>
            <span aria-hidden className={cx('grid size-7 place-items-center rounded-lg [&>svg]:size-4', card.tone)}>
              {card.icon}
            </span>
          </div>
          {card.value === undefined ? (
            <>
              <Skeleton className="mt-3 h-7 w-24" />
              <Skeleton className="mt-2 h-4 w-20" />
            </>
          ) : (
            <>
              <p className="mt-2 truncate text-2xl font-semibold tracking-tight tabular-nums" title={card.value}>
                {card.value}
              </p>
              <p className="mt-0.5 truncate text-sm text-muted tabular-nums">{card.detail}</p>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
