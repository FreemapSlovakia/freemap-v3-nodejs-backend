import Router from '@koa/router';
import { createHmac, randomBytes } from 'node:crypto';
import sql from 'sql-template-tag';
import { assert } from 'typia';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { getEnv } from '../../env.js';

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

type Body =
  | {
      type: 'premium';
    }
  | {
      type: 'credits';
      amount: number;
    };

export function attachPurchaseTokenHandler(router: Router) {
  router.post('/purchaseToken', authenticator(true), async (ctx) => {
    let body;

    try {
      body = assert<Body>(ctx.request.body);
    } catch (err) {
      return ctx.throw(400, err as Error);
    }

    const token = randomBytes(32).toString('hex');

    const expireAt = new Date(Date.now() + 3_600_000); // 1 hour

    const user = ctx.state.user!;

    await pool.query(
      sql`INSERT INTO purchaseToken SET
        userId = ${user.id},
        createdAt = NOW(),
        token = ${token},
        expireAt = ${expireAt},
        item = ${JSON.stringify(body)}`,
    );

    const expiration = Math.floor(expireAt.getTime() / 1000);

    const paymentUrl = new URL(getEnv('PURCHASE_URL_PREFIX'));

    const { searchParams } = paymentUrl;

    searchParams.set('token', token);

    searchParams.set('callbackurl', getEnv('PURCHASE_CALLBACK_URL'));

    searchParams.set('expiration', String(expiration));

    if (user.email) {
      searchParams.set('email', user.email);
    }

    const lang =
      user.language && user.language in translations
        ? user.language
        : ctx.acceptsLanguages(Object.keys(translations)) || 'en';

    searchParams.set('lang', lang);

    const translation = translations[lang]![body.type];

    searchParams.set('name', translation.title);

    searchParams.set('description', translation.description);

    switch (body.type) {
      case 'premium':
        searchParams.set('price_eur', '800');
        searchParams.set('price_chr', '80');

        break;
      case 'credits': {
        searchParams.set('price_eur', String(body.amount)); // let the exchange rate is 1
        searchParams.set('price_chr', String(Math.ceil(body.amount / 10)));

        searchParams.set(
          'description',
          translation.description.replace(
            '{}',
            Intl.NumberFormat(lang, {
              minimumFractionDigits: 0,
              maximumFractionDigits: 0,
            }).format(body.amount),
          ),
        );

        break;
      }
    }

    const paymentUrlString = paymentUrl.toString();

    ctx.body = {
      paymentUrl:
        paymentUrlString +
        '&signature=' +
        createHmac('sha256', getEnv('PURCHASE_SECRET'))
          .update(paymentUrlString)
          .digest('hex'),
    };
  });
}
