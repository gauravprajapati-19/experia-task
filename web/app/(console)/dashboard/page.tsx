import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Dashboard } from '@/components/dashboard/Dashboard';

export const metadata: Metadata = {
  title: 'Payments',
  description: 'Payment totals, statuses and recent transactions.',
};

export default function DashboardPage() {
  // useSearchParams (URL-held filters) needs a Suspense boundary
  return (
    <Suspense>
      <Dashboard />
    </Suspense>
  );
}
