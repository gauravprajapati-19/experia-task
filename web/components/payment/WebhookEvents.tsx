import { Inbox } from 'lucide-react';
import type { WebhookEvent, WebhookOutcome } from '@/lib/api';
import { formatDateTime, plural } from '@/lib/format';
import { Card, cx } from '../ui';

const OUTCOMES: Record<WebhookOutcome, { label: string; summary: (n: number) => string; style: string }> = {
  applied: {
    label: 'Applied',
    summary: (n) => `${n} applied`,
    style: 'bg-green-50 text-green-700 ring-green-600/20 dark:bg-green-500/10 dark:text-green-300 dark:ring-green-400/30',
  },
  duplicate: {
    label: 'Duplicate',
    summary: (n) => plural(n, 'duplicate'),
    style: 'bg-surface-2 text-muted ring-line',
  },
  stale: {
    label: 'Stale',
    summary: (n) => `${n} stale`,
    style: 'bg-surface-2 text-muted ring-line',
  },
  invalid_transition: {
    label: 'Rejected',
    summary: (n) => `${n} rejected (invalid transition)`,
    style: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-400/30',
  },
  unknown_payment: {
    label: 'Unknown payment',
    summary: (n) => `${n} unknown payment`,
    style: 'bg-surface-2 text-muted ring-line',
  },
};

const SUMMARY_ORDER: WebhookOutcome[] = ['applied', 'duplicate', 'stale', 'invalid_transition', 'unknown_payment'];

/**
 * "5 deliveries received · 1 applied · 4 duplicates". Each stored event was delivered once plus its
 * counted repeats; the repeats are the duplicates (guard #1 never stores them as separate rows).
 */
export function summarizeEvents(events: WebhookEvent[]): { key: string; text: string }[] {
  const counts = new Map<WebhookOutcome, number>();
  const add = (outcome: WebhookOutcome, n: number) => counts.set(outcome, (counts.get(outcome) ?? 0) + n);
  for (const event of events) {
    add(event.outcome, 1);
    add('duplicate', event.duplicateDeliveries);
  }
  const deliveries = events.reduce((sum, event) => sum + 1 + event.duplicateDeliveries, 0);

  const parts = [{ key: 'received', text: `${plural(deliveries, 'delivery', 'deliveries')} received` }];
  for (const outcome of SUMMARY_ORDER) {
    const n = counts.get(outcome) ?? 0;
    if (n > 0 || outcome === 'applied') parts.push({ key: outcome, text: OUTCOMES[outcome].summary(n) });
  }
  return parts;
}

export function WebhookEvents({ events }: { events: WebhookEvent[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-5 py-4">
        <h2 className="text-sm font-semibold">Webhook events</h2>
        {events.length > 0 && (
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-medium" aria-label="Webhook summary">
            {summarizeEvents(events).map((part, i) => (
              <span key={part.key} className="flex items-center gap-2">
                {i > 0 && (
                  <span aria-hidden className="text-muted">
                    ·
                  </span>
                )}
                <span className={cx('tabular-nums', part.key === 'applied' && 'text-green-700 dark:text-green-300')}>{part.text}</span>
              </span>
            ))}
          </p>
        )}
      </div>

      {events.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <Inbox aria-hidden className="size-6 text-muted" />
          <p className="text-sm font-medium">No webhook events yet</p>
          <p className="max-w-sm text-sm text-muted">The provider has not sent an update for this payment.</p>
        </div>
      ) : (
        <>
          <table className="hidden w-full text-sm sm:table">
            <thead className="border-b border-line bg-surface-2/60 text-left text-xs font-medium tracking-wide text-muted uppercase">
              <tr>
                <th scope="col" className="px-5 py-2.5">Event ID</th>
                <th scope="col" className="px-5 py-2.5">Status</th>
                <th scope="col" className="px-5 py-2.5">Outcome</th>
                <th scope="col" className="px-5 py-2.5">Occurred</th>
                <th scope="col" className="px-5 py-2.5">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {events.map((event) => (
                <tr key={event.eventId}>
                  <td className="max-w-64 truncate px-5 py-3 font-mono text-xs" title={event.eventId}>
                    {event.eventId}
                  </td>
                  <td className="px-5 py-3 text-xs font-medium">{event.status}</td>
                  <td className="px-5 py-3">
                    <span className="flex items-center gap-2">
                      <OutcomeBadge outcome={event.outcome} />
                      <Repeats count={event.duplicateDeliveries} />
                    </span>
                  </td>
                  <td className="px-5 py-3 whitespace-nowrap text-muted tabular-nums">{formatDateTime(event.occurredAt, true)}</td>
                  <td className="px-5 py-3 whitespace-nowrap text-muted tabular-nums">{formatDateTime(event.receivedAt, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className="divide-y divide-line sm:hidden">
            {events.map((event) => (
              <li key={event.eventId} className="space-y-1 px-5 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{event.status}</span>
                  <span className="flex items-center gap-2">
                    <Repeats count={event.duplicateDeliveries} />
                    <OutcomeBadge outcome={event.outcome} />
                  </span>
                </div>
                <p className="truncate font-mono text-xs">{event.eventId}</p>
                <p className="text-xs text-muted tabular-nums">Received {formatDateTime(event.receivedAt, true)}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

/** repeat deliveries of the same event id, e.g. "+4 duplicates" */
function Repeats({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="text-xs whitespace-nowrap text-muted tabular-nums">+{plural(count, 'duplicate')}</span>;
}

function OutcomeBadge({ outcome }: { outcome: WebhookOutcome }) {
  const style = OUTCOMES[outcome];
  return <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', style.style)}>{style.label}</span>;
}
