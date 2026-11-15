'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard can be unavailable (permissions); the value is still selectable on the page
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {copied ? <Check aria-hidden className="size-3.5 text-green-600 dark:text-green-400" /> : <Copy aria-hidden className="size-3.5" />}
    </button>
  );
}
