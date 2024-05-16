import Router from '@koa/router';
import { pool } from '../../database';
import { authenticator } from '../../authenticator';
import { bodySchemaValidator } from '../../requestValidators';

export function attachPatchUserHandler(router: Router) {
  router.patch(
    '/settings',
    authenticator(true, false),
    bodySchemaValidator({
      type: 'object',
      anyOf: [
        {
          required: ['name'],
        },
        {
          required: ['email'],
        },
        {
          required: ['lat', 'lon'],
        },
        {
          required: ['settings'],
        },
        {
          required: ['sendGalleryEmails'],
        },
        {
          required: ['language'],
        },
      ],
      properties: {
        name: {
          type: 'string',
        },
        email: {
          type: ['string', 'null'],
          format: 'email',
        },
        lat: {
          type: 'number',
        },
        lon: {
          type: 'number',
        },
        settings: {
          type: 'object',
        },
        sendGalleryEmails: {
          oneOf: [
            {
              type: 'boolean',
            },
            {
              type: 'null',
            },
          ],
        },
        language: {
          oneOf: [
            {
              type: 'string',
              minLength: 2,
              maxLength: 2,
            },
            {
              type: 'null',
            },
          ],
        },
      },
      additionalProperties: false,
    }),
    async (ctx) => {
      const { body } = ctx.request;

      const keys = Object.keys(body);

      // TODO validate duplicates

      await pool.query(
        `UPDATE user SET ${keys
          .map((key) => `${key} = ?`)
          .join(', ')} WHERE id = ?`,
        [
          ...keys.map((key) =>
            key === 'settings' ? JSON.stringify(body[key]) : body[key],
          ),
          ctx.state.user.id,
        ],
      );

      ctx.status = 204;
    },
  );
}
