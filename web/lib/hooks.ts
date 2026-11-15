'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: 5 * 60_000 });
}

/** admin-only list for the merchant selector; never requested for merchant users */
export function useMerchants(enabled: boolean) {
  return useQuery({ queryKey: ['merchants'], queryFn: api.merchants, enabled, staleTime: 5 * 60_000 });
}

export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
