import { documentPdf } from '@ca/reporting';
import type { DocumentsService } from './documents.service';

/** A made-up invoice (clearly marked SAMPLE in its number) rendered with the company's real header and branding. */
export async function renderSample(documents: DocumentsService, companyId: string) {
  const h = await documents.companyHeader(companyId, new Date());
  const today = new Date().toISOString().slice(0, 10);
  return documentPdf({
    title: 'INVOICE', currency: h.company.baseCurrency, company: h.header, logo: h.logo, style: h.style, number: 'SAMPLE-0001', watermark: 'DRAFT',
    details: [['Date', today], ['Due date', today], ['Terms', 'Net 30']],
    billTo: { name: 'Sample Customer Ltd.', address: '123 Example Street\nOttawa ON K1A 0B1', email: 'customer@example.com' },
    lines: [
      { serviceDate: today, product: 'Consulting', description: 'Sample line', quantity: '2', rate: '100.00', amount: '200.00', taxCode: 'HST_ON' },
      { serviceDate: null, product: null, description: 'Another sample line', quantity: '1', rate: '50.00', amount: '50.00', taxCode: 'HST_ON' },
    ],
    subtotal: '250.00', taxes: [{ label: 'HST 13%', amount: '32.50' }], total: '282.50', paid: '0.00', balanceDue: '282.50',
    message: 'Thank you for your business.', paymentInstructions: h.template.paymentInstructions ?? null,
  });
}
