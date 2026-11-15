'use client';

import { ErrorState } from '@/components/ui';

/** last-resort boundary for unexpected render errors; data errors are handled in place with Retry */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <ErrorState message="The page failed to render. Try again, or reload the page." onRetry={reset} />
    </main>
  );
}
