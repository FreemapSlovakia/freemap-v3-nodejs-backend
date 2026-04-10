import { createHmac, timingSafeEqual } from 'node:crypto';
import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { runInTransaction } from '../../database.js';
import { getEnv, getEnvInteger } from './../../env.js';
import { registerPath } from '../../openapi.js';

const LegacyBodySchema = z.strictObject({
  token: z.string().nonempty(),
  email: z.email(),
  signature: z.string().nonempty(),
  amount_paid: z.union([z.number(), z.string()]).optional(),
  currency: z.string().nonempty().optional(),
});

const ImmediateWebhookSchema = z.strictObject({
  event: z.literal('payment-completed'),
  token: z.string().nonempty(),
  signature: z.string().nonempty(),
  amount_paid: z.number(),
  currency: z.enum(['EUR', 'CHR']),
  email: z.email(),
  occurred_at: z.number().int(),
  expiration: z.number().int().optional(),
});

const DelayedWebhookSchema = z
  .object({
  event: z.enum(['order-placed', 'delayed-confirmed', 'delayed-rejected']),
  delivery_id: z.string().nonempty(),
  token: z.string().nonempty(),
  signature: z.string().nonempty(),
  amount_paid: z.number(),
  currency: z.literal('EUR'),
  email: z.email(),
  occurred_at: z.number().int(),
  expiration: z.number().int().optional(),
  // Spec allows empty string and unknown future values; handle defensively.
  bank_intent_status: z.string(),
})
  // Delayed webhooks may include nested objects for compatibility; allow extras.
  .passthrough();

const WebhookSchema = z.union([ImmediateWebhookSchema, DelayedWebhookSchema]);

const RequestSchema = z.union([WebhookSchema, LegacyBodySchema]);

function verifyTokenSignatureOrThrow(token: string, providedHex: string) {
  const expectedHex = createHmac('sha256', getEnv('PURCHASE_SECRET'))
    .update(token)
    .digest('hex');

  // Constant-time compare (normalize to buffers of same length).
  const exp = Buffer.from(expectedHex, 'hex');
  const prov = Buffer.from(providedHex, 'hex');

  if (prov.length !== exp.length || !timingSafeEqual(prov, exp)) {
    throw new Error('invalid signature');
  }
}

function normalizeUnixSeconds(ts: number): number {
  // Accept either UNIX seconds or UNIX milliseconds from providers.
  return ts > 1_000_000_000_000 ? Math.floor(ts / 1000) : ts;
}

function enforceFreshnessOrThrow(occurredAtRaw: number, expirationRaw?: number) {
  const now = Math.floor(Date.now() / 1000);
  const occurredAt = normalizeUnixSeconds(occurredAtRaw);
  const expiration =
    expirationRaw == null ? undefined : normalizeUnixSeconds(expirationRaw);

  // Replay mitigation window; can be widened in dev/staging where webhook clocks
  // or delivery timings may differ. Set to 0 to disable the stale-age check.
  const maxAgeSec = getEnvInteger(
    'PURCHASE_WEBHOOK_MAX_AGE_SEC',
    14 * 24 * 60 * 60,
  );
  const maxFutureSkewSec = getEnvInteger(
    'PURCHASE_WEBHOOK_MAX_FUTURE_SKEW_SEC',
    10 * 60,
  );

  if (occurredAt > now + maxFutureSkewSec) {
    throw new Error('occurred_at is too far in the future');
  }
  if (maxAgeSec > 0 && now - occurredAt > maxAgeSec) {
    throw new Error('stale occurred_at');
  }
  if (expiration != null && occurredAt > expiration) {
    throw new Error('expired');
  }
}

export function attachPurchaseValidateHandler(router: RouterInstance) {
  registerPath('/auth/purchaseValidate', {
    post: {
      summary:
        'Payment provider webhook to validate and apply a completed purchase',
      tags: ['auth'],
      requestBody: {
        content: { 'application/json': { schema: RequestSchema } },
      },
      responses: { 204: {}, 400: {}, 403: {} },
    },
  });

  router.post('/purchaseValidate', async (ctx) => {
    const raw = ctx.request.body;

    // Prefer the documented webhook schemas; keep legacy body for backward compatibility.
    const webhookRes = WebhookSchema.safeParse(raw);
    const webhook = webhookRes.success ? webhookRes.data : undefined;

    if (webhook) {
      // If headers are present, ensure they match the body for defense-in-depth.
      const hdrEvent = ctx.get('X-Rovas-Event');
      if (hdrEvent && hdrEvent !== webhook.event) {
        return ctx.throw(400, 'X-Rovas-Event does not match body.event');
      }

      if ('delivery_id' in webhook) {
        const hdrDeliveryId = ctx.get('X-Rovas-Delivery-Id');
        if (hdrDeliveryId && hdrDeliveryId !== webhook.delivery_id) {
          return ctx.throw(
            400,
            'X-Rovas-Delivery-Id does not match body.delivery_id',
          );
        }
      }

      try {
        verifyTokenSignatureOrThrow(webhook.token, webhook.signature);
        enforceFreshnessOrThrow(webhook.occurred_at, webhook.expiration);
      } catch (err) {
        return ctx.throw(403, err as Error);
      }

      await runInTransaction(async (conn) => {
        if ('delivery_id' in webhook) {
          // Deduplicate retries for delayed events.
          try {
            await conn.query(
              sql`INSERT INTO rovasWebhookDelivery SET
                deliveryId = ${webhook.delivery_id},
                token = ${webhook.token},
                event = ${webhook.event},
                occurredAt = ${webhook.occurred_at}`,
            );
          } catch {
            // Already processed this delivery id.
            ctx.status = 204;
            return;
          }
        }

        const [intent] = await conn.query(
          sql`SELECT userId, item, status FROM purchaseIntent
              WHERE token = ${webhook.token} AND expireAt > NOW()
              FOR UPDATE`,
        );

        if (!intent) {
          ctx.throw(403, 'no such token');
        }

        // Track last-seen webhook info.
        await conn.query(
          sql`UPDATE purchaseIntent SET
              lastEvent = ${webhook.event},
              lastOccurredAt = ${webhook.occurred_at},
              amountPaid = ${webhook.amount_paid},
              currency = ${webhook.currency},
              email = ${webhook.email},
              bankIntentStatus = ${'bank_intent_status' in webhook ? webhook.bank_intent_status : null}
            WHERE token = ${webhook.token}`,
        );

        if (webhook.event === 'order-placed') {
          await conn.query(
            sql`UPDATE purchaseIntent SET status = 'awaiting_payment' WHERE token = ${webhook.token}`,
          );
          return;
        }

        if (webhook.event === 'delayed-rejected') {
          await conn.query(
            sql`UPDATE purchaseIntent SET status = 'rejected' WHERE token = ${webhook.token}`,
          );
          // Do not grant access.
          return;
        }

        // payment-completed OR delayed-confirmed => grant access (idempotently).
        if (intent.status === 'confirmed') {
          return;
        }

        const { userId, item } = intent;

        await conn.query(
          sql`INSERT INTO purchase SET userId = ${userId}, item = ${item}, createdAt = NOW(), note = ${webhook.event}`,
        );

        switch (item.type) {
          case 'premium':
            await conn.query(
              sql`UPDATE user
                SET premiumExpiration =
                  CASE WHEN premiumExpiration IS NULL OR premiumExpiration < NOW()
                    THEN NOW()
                    ELSE premiumExpiration
                  END + INTERVAL 1 YEAR,
                  email = COALESCE(email, ${webhook.email})
                WHERE id = ${userId}`,
            );
            break;

          case 'credits':
            await conn.query(
              sql`UPDATE user
                  SET credits = credits + ${item.amount},
                      email = COALESCE(email, ${webhook.email})
                WHERE id = ${userId}`,
            );
            break;

          default:
            ctx.throw(new Error('invalid item type in purchase intent: ' + item.type));
        }

        await conn.query(
          sql`UPDATE purchaseIntent SET status = 'confirmed' WHERE token = ${webhook.token}`,
        );

        await conn.query(sql`DELETE FROM purchaseToken WHERE token = ${webhook.token}`);
      });

      ctx.status = 204;
      return;
    }

    // Legacy: minimal body without `event`.
    let legacy: z.infer<typeof LegacyBodySchema>;
    try {
      legacy = LegacyBodySchema.parse(raw);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    try {
      verifyTokenSignatureOrThrow(legacy.token, legacy.signature);
    } catch (err) {
      return ctx.throw(403, err as Error);
    }

    await runInTransaction(async (conn) => {
      const [row] = await conn.query(
        sql`SELECT userId, item FROM purchaseToken WHERE token = ${legacy.token} AND expireAt > NOW() FOR UPDATE`,
      );

      if (!row) {
        ctx.throw(403, 'no such token');
      }

      const { userId, item } = row;

      await conn.query(
        sql`INSERT INTO purchase SET userId = ${userId}, item = ${item}, createdAt = NOW()`,
      );

      switch (item.type) {
        case 'premium':
          await conn.query(
            sql`UPDATE user
              SET premiumExpiration =
                CASE WHEN premiumExpiration IS NULL OR premiumExpiration < NOW()
                  THEN NOW()
                  ELSE premiumExpiration
                END + INTERVAL 1 YEAR,
                email = COALESCE(email, ${legacy.email})
              WHERE id = ${userId}`,
          );
          break;

        case 'credits':
          await conn.query(
            sql`UPDATE user SET credits = credits + ${item.amount}, email = COALESCE(email, ${legacy.email}) WHERE id = ${userId}`,
          );
          break;

        default:
          ctx.throw(new Error('invalid item type in purchase token: ' + item.type));
      }

      await conn.query(sql`DELETE FROM purchaseToken WHERE token = ${legacy.token}`);
      await conn.query(
        sql`UPDATE purchaseIntent SET status = 'confirmed' WHERE token = ${legacy.token}`,
      );
    });

    ctx.status = 204;
  });
}
