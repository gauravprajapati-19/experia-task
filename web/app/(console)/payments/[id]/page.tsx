import type { Metadata } from 'next';
import { PaymentDetailsView } from '@/components/payment/PaymentDetailsView';

export const metadata: Metadata = {
  title: 'Payment details',
  description: 'Status, audit timeline and webhook events for one payment.',
};

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PaymentDetailsView id={id} />;
}
