'use client';

import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Store } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useMe, useMerchants } from '@/lib/hooks';
import { ThemeToggle } from './ThemeToggle';
import { Button, Skeleton } from './ui';

export function TopBar() {
  const me = useMe();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await api.logout();
    } finally {
      queryClient.clear();
      router.replace('/login');
    }
  }

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold tracking-tight">
          <span aria-hidden className="grid size-7 place-items-center rounded-lg bg-accent text-accent-ink">
            <Store className="size-4" />
          </span>
          <span className="hidden min-[400px]:inline">Merchant Console</span>
        </Link>

        <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
          {me.isPending ? (
            <Skeleton className="h-5 w-28" />
          ) : me.data?.role === 'admin' ? (
            <AdminScope />
          ) : me.data ? (
            <span className="truncate text-sm text-muted" title={me.data.email}>
              {me.data.merchantName}
            </span>
          ) : null}
          <ThemeToggle />
          <Button variant="ghost" onClick={signOut} disabled={signingOut} aria-label="Sign out" title="Sign out" className="px-2.5">
            <LogOut aria-hidden className="size-4" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

/** admin only; "All merchants" is the default */
function AdminScope() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const merchants = useMerchants(true);

  if (pathname !== '/dashboard') {
    return <span className="text-sm text-muted">Admin</span>;
  }

  function select(merchantId: string) {
    const params = new URLSearchParams(searchParams);
    if (merchantId) params.set('merchantId', merchantId);
    else params.delete('merchantId');
    params.delete('page');
    const query = params.toString();
    router.replace(query ? `/dashboard?${query}` : '/dashboard', { scroll: false });
  }

  return (
    <label className="flex min-w-0 items-center gap-2 text-sm">
      <span className="hidden text-muted sm:inline">Merchant</span>
      <select
        value={searchParams.get('merchantId') ?? ''}
        onChange={(e) => select(e.target.value)}
        disabled={merchants.isPending}
        aria-label="Merchant"
        className="h-9 min-w-0 max-w-40 rounded-lg border border-line bg-surface px-2 text-sm sm:max-w-none"
      >
        <option value="">All merchants</option>
        {merchants.data?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </label>
  );
}
