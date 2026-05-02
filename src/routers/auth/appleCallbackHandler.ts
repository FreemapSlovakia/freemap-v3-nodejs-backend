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
    
    const searchParams = new URLSearchParams(body as Record<string, string>).toString();
    const intentUrl = `intent://callback?${searchParams}#Intent;package=sk.bigware.freemap;scheme=signinwithapple;end`;
    
    const userAgent = ctx.request.headers['user-agent'] || '';
    const isAndroid = /Android/i.test(userAgent);

    if (isAndroid) {
      ctx.log.info({ intentUrl }, 'Redirecting Android to intent directly via 307');
      ctx.status = 307;
      ctx.redirect(intentUrl);
      return;
    }
    
    ctx.log.info('Serving HTML for Web Apple Sign In callback');
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
    if (!window.opener) {
      window.location.replace("${intentUrl}");
    } else {
      // Apple JS and Flutter sign_in_with_apple_web expect the data as a query string message
      window.opener.postMessage("?" + "${searchParams}", "*");
      window.close();
    }
  </script>
</body>
</html>`;
  });
}
