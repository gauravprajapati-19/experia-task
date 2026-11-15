'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CheckCircle2, Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PAYMENT_STATUSES, api, type Payment, type PaymentFilters, type PaymentStatus } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { useDebounced, useMe, useMerchants } from '@/lib/hooks';
import { Button, cx } from '../ui';
import { CreatePaymentDialog } from './CreatePaymentDialog';
import { PaymentsTable } from './PaymentsTable';
import { SummaryCards } from './SummaryCards';

export const PAGE_SIZES = [10, 20, 50] as const;

/** filters live in the URL so a refresh, a shared link or the back button keeps them */
function readFilters(params: URLSearchParams): PaymentFilters {
  const page = Number(params.get('page'));
  const pageSize = Number(params.get('pageSize'));
  const status = params.get('status')?.toUpperCase();
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: (PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : 10,
    status: PAYMENT_STATUSES.includes(status as PaymentStatus) ? (status as PaymentStatus) : undefined,
    q: params.get('q')?.trim() || undefined,
    merchantId: params.get('merchantId') || undefined,
  };
}

export function Dashboard() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = readFilters(searchParams);
  const me = useMe();
  const isAdmin = me.data?.role === 'admin';
  const merchantId = isAdmin ? filters.merchantId : undefined;
  const merchants = useMerchants(isAdmin);

  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<Payment | null>(null);

  function setFilters(patch: Partial<PaymentFilters>) {
    const next = { ...filters, ...patch };
    const params = new URLSearchParams();
    if (next.merchantId) params.set('merchantId', next.merchantId);
    if (next.q) params.set('q', next.q);
    if (next.status) params.set('status', next.status);
    if (next.page > 1) params.set('page', String(next.page));
    if (next.pageSize !== 10) params.set('pageSize', String(next.pageSize));
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const [search, setSearch] = useState(filters.q ?? '');
  const debouncedSearch = useDebounced(search.trim(), 300);
  useEffect(() => {
    if ((debouncedSearch || undefined) !== filters.q) setFilters({ q: debouncedSearch || undefined, page: 1 });
    // only a new debounced value should trigger this; filters are read fresh from the URL
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const listFilters = { ...filters, merchantId };
  const summary = useQuery({
    queryKey: ['summary', merchantId ?? null],
    queryFn: () => api.summary(merchantId),
    enabled: me.isSuccess,
  });
  const payments = useQuery({
    queryKey: ['payments', listFilters],
    queryFn: () => api.listPayments(listFilters),
    enabled: me.isSuccess,
    placeholderData: keepPreviousData,
  });

  // A page number past the end (e.g. after narrowing a filter in another tab) snaps to the last page.
  const totalPages = payments.data?.totalPages ?? 0;
  useEffect(() => {
    if (totalPages > 0 && filters.page > totalPages) setFilters({ page: totalPages });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPages, filters.page]);

  const merchantName = (id: string) => merchants.data?.find((m) => m.id === id)?.name;
  const scopeName = isAdmin ? (merchantId ? (merchantName(merchantId) ?? 'Selected merchant') : 'All merchants') : me.data?.merchantName;
  const hasFilters = Boolean(filters.q || filters.status);
  const canCreate = me.data?.role === 'merchant';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Payments</h1>
          <p className="mt-1 text-sm text-muted">{scopeName ?? ' '}</p>
        </div>
        {canCreate && (
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden className="size-4" /> Create test payment
          </Button>
        )}
      </div>

      {created && (
        <div
          role="status"
          className="animate-fade-up flex items-start gap-3 rounded-xl border border-green-600/25 bg-green-50 p-3 text-sm text-green-800 dark:border-green-400/25 dark:bg-green-500/10 dark:text-green-200"
        >
          <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 flex-1">
            Created <span className="font-mono break-all">{created.reference}</span> for {formatPaise(created.amountPaise)}.{' '}
            {created.needsReconciliation
              ? 'The provider did not confirm it in time, so it stays Pending until reconciliation checks it.'
              : 'It stays Pending until the provider sends a webhook.'}{' '}
            <Link href={`/payments/${created.id}`} className="font-medium underline underline-offset-2">
              View details
            </Link>
          </p>
          <button type="button" onClick={() => setCreated(null)} aria-label="Dismiss" className="rounded p-0.5 hover:bg-green-600/10">
            <X aria-hidden className="size-4" />
          </button>
        </div>
      )}

      <SummaryCards query={summary} />

      <section aria-labelledby="transactions-heading" className="space-y-3">
        <h2 id="transactions-heading" className="sr-only">
          Transactions
        </h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by reference or provider ID"
              aria-label="Search by reference or provider ID"
              maxLength={100}
              className="h-10 w-full rounded-lg border border-line bg-surface pr-3 pl-9 text-sm placeholder:text-muted"
            />
          </div>
          <select
            value={filters.status ?? ''}
            onChange={(e) => setFilters({ status: (e.target.value || undefined) as PaymentStatus | undefined, page: 1 })}
            aria-label="Filter by status"
            className="h-10 rounded-lg border border-line bg-surface px-3 text-sm sm:w-44"
          >
            <option value="">All statuses</option>
            <option value="SUCCESS">Success</option>
            <option value="PENDING">Pending</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>

        <PaymentsTable
          query={payments}
          showMerchant={isAdmin && !merchantId}
          merchantName={merchantName}
          hasFilters={hasFilters}
          canCreate={canCreate}
          onCreate={() => setCreateOpen(true)}
          onClearFilters={() => {
            setSearch('');
            setFilters({ q: undefined, status: undefined, page: 1 });
          }}
        />

        {payments.data && payments.data.total > 0 && (
          <Pagination
            page={payments.data.page}
            pageSize={payments.data.pageSize}
            total={payments.data.total}
            totalPages={payments.data.totalPages}
            loading={payments.isFetching}
            onPage={(page) => setFilters({ page })}
            onPageSize={(pageSize) => setFilters({ pageSize, page: 1 })}
          />
        )}
      </section>

      {canCreate && (
        <CreatePaymentDialog
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={(payment) => {
            setCreated(payment);
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Pagination(props: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  loading: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const first = (props.page - 1) * props.pageSize + 1;
  const last = Math.min(props.page * props.pageSize, props.total);
  return (
    <nav aria-label="Pagination" className="flex flex-col-reverse items-center justify-between gap-3 text-sm sm:flex-row">
      <p className={cx('text-muted tabular-nums', props.loading && 'opacity-60')} aria-live="polite">
        Showing {first}–{last} of {props.total}
      </p>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-muted">
          <span className="hidden min-[400px]:inline">Rows</span>
          <select
            value={props.pageSize}
            onChange={(e) => props.onPageSize(Number(e.target.value))}
            aria-label="Rows per page"
            className="h-9 rounded-lg border border-line bg-surface px-2 text-ink"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => props.onPage(props.page - 1)} disabled={props.page <= 1}>
          Previous
        </Button>
        <span className="px-1 text-muted tabular-nums">
          {props.page} / {Math.max(props.totalPages, 1)}
        </span>
        <Button onClick={() => props.onPage(props.page + 1)} disabled={props.page >= props.totalPages}>
          Next
        </Button>
      </div>
    </nav>
  );
}
