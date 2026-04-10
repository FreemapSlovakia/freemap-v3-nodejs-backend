import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { zDateToIso } from '../../types.js';

const PurchaseItemSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('premium') }),
  z.strictObject({
    type: z.literal('credits'),
    amount: z.number().positive(),
  }),
]);

const PurchaseSchema = z.strictObject({
  item: PurchaseItemSchema,
  createdAt: zDateToIso,
});

const PurchaseIntentSchema = z.strictObject({
  item: PurchaseItemSchema,
  status: z.enum(['created', 'awaiting_payment', 'rejected']),
  createdAt: zDateToIso,
  updatedAt: zDateToIso,
  expireAt: zDateToIso,
  bankIntentStatus: z.string().nullable(),
});

const ResponseSchema = z.strictObject({
  purchases: z.array(PurchaseSchema),
  intents: z.array(PurchaseIntentSchema),
});

function stripLegacyPurchaseItemFields(item: unknown) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return item;
  }

  const { callbackUrl: _callbackUrl, ...rest } = item as Record<string, unknown>;
  return rest;
}

export function attachGetPurchasesHandler(router: RouterInstance) {
  registerPath('/auth/purchases', {
    get: {
      summary: "List the authenticated user's purchases",
      tags: ['auth'],
      security: AUTH_REQUIRED,
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
        401: {},
      },
    },
  });

  router.get('/purchases', authenticator(true), async (ctx) => {
    const userId = ctx.state.user!.id;

    const purchases = await pool.query(
      sql`SELECT item, createdAt FROM purchase WHERE userId = ${userId}`,
    );

    const intents = await pool.query(
      sql`SELECT item, status, createdAt, updatedAt, expireAt, bankIntentStatus
          FROM purchaseIntent
          WHERE userId = ${userId}
            AND status IN ('created','awaiting_payment','rejected')
            AND expireAt > (NOW() - INTERVAL 7 DAY)
          ORDER BY updatedAt DESC`,
    );

    ctx.body = ResponseSchema.parse({
      purchases: purchases.map((purchase: { item: unknown }) => ({
        ...purchase,
        item: stripLegacyPurchaseItemFields(purchase.item),
      })),
      intents: intents.map((intent: { item: unknown }) => ({
        ...intent,
        item: stripLegacyPurchaseItemFields(intent.item),
      })),
    });
  });
}
