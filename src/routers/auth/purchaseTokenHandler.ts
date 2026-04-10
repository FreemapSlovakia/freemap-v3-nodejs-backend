import { createHmac, randomBytes } from 'node:crypto';
import { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';
import { AUTH_REQUIRED, registerPath } from '../../openapi.js';

function buildCanonicalRovasUrlToSign(url: URL): string {
  // Rovas expects signature over the full absolute URL without the `signature`
  // parameter, preserving the exact query parameter order used to build the link.
  const canonical = new URL(url.toString());
  canonical.searchParams.delete('signature');
  return canonical.toString();
}

type Combo = {
  title: string;
  description: string;
};

type Translation = {
  premium: Combo;
  credits: Combo;
};

const translations: Record<string, Translation> = {
  en: {
    premium: {
      title: 'Freemap.sk premium access',
      description: 'Premium access to Freemap.sk for 1 year',
    },
    credits: {
      title: 'Freemap.sk credits',
      description: 'Purchase of {} Freemap.sk credits',
    },
  },
  sk: {
    premium: {
      title: 'Freemap.sk prémiový prístup',
      description: 'Prémiový prístup na Freemap.sk na 1 rok',
    },
    credits: {
      title: 'Freemap.sk kredity',
      description: 'Nákup {} kreditov Freemap.sk',
    },
  },
  cs: {
    premium: {
      title: 'Freemap.sk prémiový přístup',
      description: 'Prémiový přístup na Freemap.sk na 1 rok',
    },
    credits: {
      title: 'Freemap.sk kredity',
      description: 'Nákup {} kreditů Freemap.sk',
    },
  },
  hu: {
    premium: {
      title: 'Freemap.sk prémium hozzáférés',
      description: 'Prémium hozzáférés a Freemap.sk-hoz 1 évre',
    },
    credits: {
      title: 'Freemap.sk kreditek',
      description: '{} Freemap.sk kredit vásárlása',
    },
  },
  de: {
    premium: {
      title: 'Freemap.sk Premium-Zugang',
      description: 'Premium-Zugang zu Freemap.sk für 1 Jahr',
    },
    credits: {
      title: 'Freemap.sk Guthaben',
      description: 'Kauf von {} Freemap.sk Guthaben',
    },
  },
  it: {
    premium: {
      title: 'Accesso premium a Freemap.sk',
      description: 'Accesso premium a Freemap.sk per 1 anno',
    },
    credits: {
      title: 'Crediti Freemap.sk',
      description: 'Acquisto di {} crediti Freemap.sk',
    },
  },
  pl: {
    premium: {
      title: 'Dostęp premium do Freemap.sk',
      description: 'Dostęp premium do Freemap.sk na 1 rok',
    },
    credits: {
      title: 'Kredyty Freemap.sk',
      description: 'Zakup {} kredytów Freemap.sk',
    },
  },
};

const BodySchema = z.union([
  z.strictObject({ callbackUrl: z.url(), type: z.literal('premium') }),
  z.strictObject({
    callbackUrl: z.url(),
    type: z.literal('credits'),
    amount: z.number(),
  }),
]);

const ResponseSchema = z.strictObject({ paymentUrl: z.url() });

export function attachPurchaseTokenHandler(router: RouterInstance) {
  registerPath('/auth/purchaseToken', {
    post: {
      summary: 'Create a payment URL for a premium or credits purchase',
      tags: ['auth'],
      security: AUTH_REQUIRED,
      requestBody: { content: { 'application/json': { schema: BodySchema } } },
      responses: {
        200: { content: { 'application/json': { schema: ResponseSchema } } },
        400: {},
        401: {},
      },
    },
  });

  router.post('/purchaseToken', authenticator(true), async (ctx) => {
    let body;

    try {
      body = BodySchema.parse(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const token = randomBytes(32).toString('hex');

    const expireAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days

    const user = ctx.state.user!;

    const { callbackUrl, ...item } = body;

    await pool.query(
      sql`INSERT INTO purchaseToken SET
        userId = ${user.id},
        createdAt = NOW(),
        token = ${token},
        expireAt = ${expireAt},
        item = ${JSON.stringify(item)}`,
    );

    await pool.query(
      sql`INSERT INTO purchaseIntent SET
        userId = ${user.id},
        createdAt = NOW(),
        token = ${token},
        expireAt = ${expireAt},
        item = ${JSON.stringify(body)},
        status = 'created'`,
    );

    const expiration = Math.floor(expireAt.getTime() / 1000);

    const paymentUrl = new URL(getEnv('PURCHASE_URL_PREFIX'));

    const { searchParams } = paymentUrl;

    // NOTE: query parameter order matters for the signed string; keep a stable order
    // by appending in the intended sequence.
    searchParams.set('token', token);

    searchParams.set('callback_url', callbackUrl);

    searchParams.set('expiration', String(expiration));

    if (user.email) {
      searchParams.set('email', user.email);
    }

    const lang =
      user.language && user.language in translations
        ? user.language
        : ctx.acceptsLanguages(Object.keys(translations)) || 'en';

    searchParams.set('lang', lang);

    const translation = translations[lang]![item.type];

    searchParams.set('name', translation.title);

    searchParams.set('description', translation.description);

    switch (item.type) {
      case 'premium':
        // Prices are in minor units: euro cents / chron cents.
        searchParams.set('price_eur', '800');
        searchParams.set('price_chr', '8000');

        break;
      case 'credits': {
        // `amount` is the number of credits; price is expressed in euro cents.
        // 1 EUR = 10 CHR, so 1 euro cent = 10 chron cents.
        searchParams.set('price_eur', String(item.amount));
        searchParams.set('price_chr', String(item.amount * 10));

        searchParams.set(
          'description',
          translation.description.replace(
            '{}',
            Intl.NumberFormat(lang, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            }).format(item.amount),
          ),
        );

        break;
      }
    }

    const canonicalToSign = buildCanonicalRovasUrlToSign(paymentUrl);

    ctx.body = ResponseSchema.parse({
      paymentUrl:
        canonicalToSign +
        (canonicalToSign.includes('?') ? '&' : '?') +
        'signature=' +
        createHmac('sha256', getEnv('PURCHASE_SECRET'))
          .update(canonicalToSign)
          .digest('hex'),
    });
  });
}
