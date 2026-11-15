import { FileQuestion } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClass } from '@/components/ui';

export const metadata: Metadata = { title: 'Page not found' };

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <FileQuestion aria-hidden className="size-8 text-muted" />
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="text-sm text-muted">The page you are looking for does not exist.</p>
        <Link href="/dashboard" className={buttonClass('secondary')}>
          Go to payments
        </Link>
      </div>
    </main>
  );
}
