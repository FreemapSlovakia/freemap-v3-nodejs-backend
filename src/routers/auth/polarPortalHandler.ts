import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';
import { getPolar } from '../../polar.js';

const BodySchema = z.strictObject({
  // Shows a "back" button in the portal that returns here.
  returnUrl: z.url().optional(),
});

const ResponseSchema = z.strictObject({ portalUrl: z.url() });

// Polar answers an unknown customer with a 422 on the customer field, not a 404.
function isMissingCustomer(err: unknown): boolean {
  const { statusCode, error } = err as { statusCode?: number; error?: unknown };

  if (statusCode !== 422 || typeof error !== 'object' || error === null) {
    return false;
  }

  const { detail } = error as { detail?: { type?: string; loc?: unknown[] }[] };

  // Only `value_error`: any invalid body also reports the other union variant's
  // customer field as `missing`.
  return (
    Array.isArray(detail) &&
    detail.some(
      (d) =>
        d.type === 'value_error' &&
        (d.loc?.includes('customer_id') ||
          d.loc?.includes('external_customer_id')),
    )
  );
}

export function attachPolarPortalHandler(router: RouterInstance) {
  registerPath('/auth/polar/portal', {
    post: {
      summary:
        'Create a pre-authenticated Polar customer portal link for the user',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
        400: {},
        401: {},
        404: {},
        502: {},
      },
    },
  });

  router.post('/polar/portal', authenticator(true), async (ctx) => {
    const user = ctx.state.user!;

    let body;

    try {
      body = BodySchema.parse(ctx.request.body ?? {});
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    // Prefer the stored customer ID over the external one for the same reason
    // the webhook does: after an account merge the surviving user can hold a
    // customer whose Polar `external_id` still names the account that was
    // merged away, so looking up by our user ID would miss it (or, worse, find
    // the wrong customer). Users who only ever bought credits have no stored ID
    // — the checkout always sets `external_customer_id`, so that covers them.
    const rows = await pool.query<{ polarCustomerId: string | null }[]>(
      sql`SELECT polarCustomerId FROM user WHERE id = ${user.id}`,
    );

    const customerId = rows[0]?.polarCustomerId ?? null;

    let session;

    try {
      session = await getPolar().customerSessions.create({
        ...(customerId === null
          ? { external_customer_id: String(user.id) }
          : { customer_id: customerId }),
        ...(body.returnUrl === undefined ? {} : { return_url: body.returnUrl }),
      });
    } catch (err) {
      // Nothing was ever bought through Polar, so there is no customer to open
      // a portal for. Distinguished from a real outage so the client can simply
      // not offer the link rather than show an error.
      if (isMissingCustomer(err)) {
        return ctx.throw(404, 'no Polar customer');
      }

      ctx.log.error({ err }, 'Polar customer session creation failed');

      return ctx.throw(502, 'failed to create customer portal session');
    }

    ctx.body = ResponseSchema.parse({ portalUrl: session.customer_portal_url });
  });
}
