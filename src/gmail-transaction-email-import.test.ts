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

  it('imports Amazon order bodies as ignored item evidence when a total is present', () => {
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
      categoryId: 'ignored',
      ignored: true,
      tags: ['amazon', 'needs_item_data', 'amazon_evidence_only', 'ignored'],
      source: {
        source: 'amazon_order_email',
      },
    });
  });

  it('imports gift-card-funded Amazon order bodies as ignored item evidence', () => {
    const result = importGmailTransactionEmails([
      {
        uid: 202,
        date: 'Fri, 08 May 2026 19:45:56 -0500',
        from: 'Rob Bonner <robbonner@mac.com>',
        subject: 'Fwd: Ordered: "Silicon Power 512GB NVMe ..." and 1 more item',
        messageId: '<amazon-202@example.test>',
        bodyText: [
          'Begin forwarded message:',
          'From: "Amazon.com" <auto-confirm@amazon.com>',
          'Subject: Ordered: "Silicon Power 512GB NVMe..." and 1 more item',
          'Order # 113-0108880-6249018',
          'Silicon Power 512GB NVMe M.2 PCIe Gen3x4 2280 SSD',
          'Quantity: 1',
          'ASTARON M.2 SSD Screws Kit, Nvme Mounting Screws',
          'Quantity: 1',
          'Item Subtotal: $120.11',
          'Gift Card Amount: -$120.11',
          'Grand Total: $0.00',
        ].join('\n'),
      },
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.transactions[0]).toMatchObject({
      postedDate: '2026-05-08',
      merchant: 'Amazon',
      amount: 120.11,
      categoryId: 'ignored',
      categoryConfidence: 0.72,
      classificationMethod: 'inferred',
      ignored: true,
      tags: [
        'amazon',
        'needs_item_data',
        'amazon_evidence_only',
        'ignored',
        'amazon_credit_spend',
        'zero_payment_total',
      ],
      source: {
        source: 'amazon_order_email',
      },
      rawEvidence: {
        amazonOrderId: '113-0108880-6249018',
        amazonEmailKind: 'ordered',
        amazonItems: [
          'Silicon Power 512GB NVMe M.2 PCIe Gen3x4 2280 SSD',
          'ASTARON M.2 SSD Screws Kit, Nvme Mounting Screws',
        ],
        amazonItemDetails: [
          {
            name: 'Silicon Power 512GB NVMe M.2 PCIe Gen3x4 2280 SSD',
            quantity: 1,
          },
          {
            name: 'ASTARON M.2 SSD Screws Kit, Nvme Mounting Screws',
            quantity: 1,
          },
        ],
      },
    });
  });

  it('extracts item-level Amazon prices from shipped order cards', () => {
    const result = importGmailTransactionEmails([
      {
        uid: 204,
        date: 'Tue, 05 May 2026 11:00:00 -0500',
        from: 'Amazon.com <shipment-tracking@amazon.com>',
        subject: 'Shipped: "Titeck Barn Door Hardware..."',
        messageId: '<amazon-204@example.test>',
        bodyText: [
          'Order # 113-8836575-8891433',
          "* Titeck Barn Door Hardware Kit -6.6FT Sliding Door Hardware with Adjustable Floor Guide, 2 Handles and Latch -Fit 36''-40'' Wide Panel, I Shape Hanger, Black",
          'Quantity: 1',
          '37.99 USD',
          'Total',
          '41.120000000000005 USD',
        ].join('\n'),
      },
    ]);

    expect(result.transactions[0]).toMatchObject({
      amount: 41.12,
      rawEvidence: {
        amazonOrderId: '113-8836575-8891433',
        amazonEmailKind: 'shipped',
        amazonItems: [
          "Titeck Barn Door Hardware Kit -6.6FT Sliding Door Hardware with Adjustable Floor Guide, 2 Handles and Latch -Fit 36''-40'' Wide Panel, I Shape Hanger, Black",
        ],
        amazonItemDetails: [
          {
            name: "Titeck Barn Door Hardware Kit -6.6FT Sliding Door Hardware with Adjustable Floor Guide, 2 Handles and Latch -Fit 36''-40'' Wide Panel, I Shape Hanger, Black",
            quantity: 1,
            price: 37.99,
          },
        ],
      },
    });
  });

  it('keeps Amazon delivery notices as ignored evidence even when item prices appear', () => {
    const result = importGmailTransactionEmails([
      {
        uid: 203,
        date: 'Fri, 08 May 2026 19:51:00 -0500',
        from: 'Rob Bonner <robbonner@mac.com>',
        subject: 'Fwd: Delivered: "Silicon Power 512GB NVMe..." and 1 more item',
        messageId: '<amazon-203@example.test>',
        bodyText: [
          'Begin forwarded message:',
          'From: "Amazon.com" <shipment-tracking@amazon.com>',
          'Subject: Delivered: "Silicon Power 512GB NVMe..." and 1 more item',
          'Order # 113-0108880-6249018',
          'Silicon Power 512GB NVMe SSD',
          '$22.49',
        ].join('\n'),
      },
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.transactions[0]).toMatchObject({
      postedDate: '2026-05-08',
      merchant: 'Amazon',
      amount: 0,
      categoryId: 'ignored',
      categoryConfidence: 0.9,
      classificationMethod: 'inferred',
      ignored: true,
      tags: ['amazon', 'needs_item_data', 'delivery_notice', 'ignored'],
      source: {
        source: 'amazon_order_email',
      },
      rawEvidence: {
        amazonOrderId: '113-0108880-6249018',
        amazonEmailKind: 'delivered',
        amazonItems: [],
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
