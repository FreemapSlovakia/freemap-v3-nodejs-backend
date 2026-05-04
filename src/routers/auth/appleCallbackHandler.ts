import { RouterInstance } from '@koa/router';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';

export function attachAppleCallbackHandler(router: RouterInstance) {
  registerPath('/auth/apple-callback', {
    post: {
      summary: 'Apple OAuth Callback for Android',
      tags: ['auth'],
      security: AUTH_OPTIONAL,
      responses: {
        307: {
          description: 'Redirects to Android App via Intent',
        },
      },
    },
  });

  router.post('/apple-callback', async (ctx) => {
    // Apple sends application/x-www-form-urlencoded
    const body = ctx.request.body || {};
    const userAgent = (ctx.request.header['user-agent'] || '').toLowerCase();
    const isAndroid = userAgent.includes('android');

    const searchParams = new URLSearchParams(body as Record<string, string>).toString();
    const intentUrl = `intent://callback?${searchParams}#Intent;package=sk.bigware.freemap;scheme=signinwithapple;end`;
    ctx.log.info({ intentUrl, isAndroid, userAgent: ctx.request.header['user-agent'] }, 'Handling Apple Sign In callback');

    if (isAndroid) {
      // Chrome Custom Tab blocks JS-based intent:// redirects (no user gesture).
      // Server-side 302 redirects ARE allowed and followed by Chrome Custom Tab.
      // 302 is specifically used instead of 307 because Chrome often blocks POST redirects to intent:// URIs.
      ctx.status = 302;
      ctx.set('Location', intentUrl);
      ctx.body = '';
      return;
    }

    // Web popup flow: Apple JS SDK handles popup communication.
    // If window.opener exists it means we are in a popup - postMessage to Flutter web.
    // Otherwise show a fallback page or try JS redirect.
    ctx.status = 200;
    ctx.type = 'text/html';
    ctx.body = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Apple Sign In Callback</title>
</head>
<body>
  <script>
    if (window.opener) {
      // Apple JS and Flutter sign_in_with_apple_web expect the data as a query string message
      window.opener.postMessage("?" + "${searchParams}", "*");
      window.close();
    } else {
      // Fallback: JS redirect just in case, or show manual link
      window.location.replace("${intentUrl}");
      document.write('<p>Prihlásenie dokončené. Vráťte sa do aplikácie.</p>');
    }
  </script>
</body>
</html>`;
  });
}
