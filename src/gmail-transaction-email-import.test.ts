import { describe, expect, it } from 'vitest';
import { importGmailTransactionEmails } from './gmail-transaction-email-import';

describe('Gmail transaction email import', () => {
  it('imports Chase transaction alert subjects as credit-card spending', () => {
    const result = importGmailTransactionEmails(
      [
        {
          uid: 101,
          date: 'Fri, 08 May 2026 15:11:00 -0500',
          from: 'Chase <no.reply.alerts@chase.com>',
          subject: 'You made a $97.41 transaction with DSW.',
          messageId: '<chase-101@example.test>',
        },
      ],
      {
        accountId: 'gmail-transactions',
        mailbox: 'INBOX',
        importedAtIso: '2026-05-08T20:00:00.000Z',
      },
    );

    expect(result.transactions).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
    expect(result.transactions[0]).toMatchObject({
      postedDate: '2026-05-08',
      merchant: 'DSW',
      amount: 97.41,
      categoryId: 'uncategorized',
      classificationMethod: 'uncategorized',
      source: {
        source: 'credit_card_email',
        sourceId: '<chase-101@example.test>',
        parserVersion: 'gmail-transaction-email-v1',
      },
    });
  });

  it('keeps Amazon card alerts in the Amazon holding bucket', () => {
    const result = importGmailTransactionEmails([
      {
        uid: 102,
        date: 'Fri, 08 May 2026 16:00:00 -0500',
        from: 'Chase <no.reply.alerts@chase.com>',
        subject: 'You made a $92.53 transaction with AMAZON MKTPLACE PMTS',
        messageId: '<chase-102@example.test>',
      },
    ]);

    expect(result.transactions[0]).toMatchObject({
      merchant: 'AMAZON MKTPLACE PMTS',
      amount: 92.53,
      categoryId: 'amazon_uncategorized',
      classificationMethod: 'inferred',
      tags: ['amazon', 'needs_item_data'],
    });
  });

  it('imports Amazon order bodies when a total is present', () => {
    const result = importGmailTransactionEmails([
      {
        uid: 201,
        date: 'Thu, 07 May 2026 20:00:00 -0500',
        from: 'Amazon.com <shipment-tracking@amazon.com>',
        subject: 'Ordered: "Silicon Power 512G B NVMe..." and 1 more item',
        messageId: '<amazon-201@example.test>',
        bodyText: 'Order Total: $43.27\nArriving tomorrow',
      },
    ]);

    expect(result.transactions[0]).toMatchObject({
      postedDate: '2026-05-07',
      merchant: 'Amazon',
      amount: 43.27,
      categoryId: 'amazon_uncategorized',
      source: {
        source: 'amazon_order_email',
      },
    });
  });

  it('records unsupported account/security mail as issues instead of transactions', () => {
    const result = importGmailTransactionEmails([
      {
        uid: 301,
        date: 'Fri, 08 May 2026 17:00:00 -0500',
        from: 'Google <no-reply@accounts.google.com>',
        subject: 'Security alert',
        messageId: '<security-301@example.test>',
      },
    ]);

    expect(result.transactions).toHaveLength(0);
    expect(result.issues).toEqual([
      {
        uid: 301,
        code: 'missing_amount',
        message: 'Email does not match a supported transaction format yet.',
      },
    ]);
  });
});
