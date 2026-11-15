import { ArrowRight, Globe, Plug, RefreshCcw } from 'lucide-react';
import type { AuditEntry, AuditSource } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { StatusBadge } from '../ui';

const SOURCES: Record<AuditSource, { label: string; icon: typeof Globe }> = {
  api: { label: 'API', icon: Globe },
  webhook: { label: 'Webhook', icon: Plug },
  reconciliation: { label: 'Reconciliation', icon: RefreshCcw },
};

export function AuditTimeline({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <p className="mt-4 text-sm text-muted">No status changes recorded.</p>;

  return (
    <ol className="mt-4 space-y-0">
      {entries.map((entry, i) => {
        const source = SOURCES[entry.source];
        const Icon = source.icon;
        return (
          <li key={entry.id} className="relative flex gap-3 pb-5 last:pb-0">
            {i < entries.length - 1 && <span aria-hidden className="absolute top-8 bottom-0 left-[15px] w-px bg-line" />}
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full border border-line bg-surface-2 text-muted">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                {entry.fromStatus ? <StatusBadge status={entry.fromStatus} /> : <span className="text-muted">Created</span>}
                <ArrowRight aria-label="to" className="size-3.5 text-muted" />
                <StatusBadge status={entry.toStatus} />
                <span className="ml-1 text-muted">via {source.label}</span>
              </div>
              <p className="mt-1 text-xs text-muted tabular-nums">
                {formatDateTime(entry.createdAt, true)}
                {entry.actor ? ` · ${entry.actor}` : ''}
              </p>
              {entry.sourceRef && <p className="mt-0.5 font-mono text-xs break-all text-muted">{entry.sourceRef}</p>}
              {entry.note && <p className="mt-1 text-sm">{entry.note}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
