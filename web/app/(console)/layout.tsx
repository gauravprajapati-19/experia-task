import { Suspense, type ReactNode } from 'react';
import { TopBar } from '@/components/TopBar';

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={<div className="h-14 border-b border-line bg-surface" />}>
        <TopBar />
      </Suspense>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </>
  );
}
