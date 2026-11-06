import type { RouterInstance } from '@koa/router';
import sql from 'sql-template-tag';
import z from 'zod';
import { authenticator } from '../../authenticator.js';
import { pool } from '../../database.js';
import { AUTH_OPTIONAL, registerPath } from '../../openapi.js';
import { acceptValidator } from '../../requestValidators.js';
import { zDateToIso } from '../../types.js';
import { EventUserSchema, ParticipationSchema } from './types.js';

const ParticipantSchema = z
  .strictObject({
    user: EventUserSchema,
    status: ParticipationSchema,
    createdAt: zDateToIso,
  })
  .meta({ id: 'EventParticipant' });

const RowSchema = z.object({
  userId: z.uint32(),
  name: z.string(),
  hasPicture: z.coerce.boolean(),
  premium: z.coerce.boolean(),
  status: ParticipationSchema,
  createdAt: z.date(),
});

export function attachParticipantsHandler(router: RouterInstance) {
  registerPath('/events/{id}/participants', {
    get: {
      summary: 'List who is going to an event and who is interested',
      tags: ['events'],
      security: AUTH_OPTIONAL,
      requestParams: {
        path: z.object({ id: z.string().nonempty() }),
      },
      responses: {
        200: {
          content: {
            'application/json': { schema: ParticipantSchema.array() },
          },
        },
        404: { description: 'no such event' },
      },
    },
  });

  router.get(
    '/:id/participants',
    acceptValidator('application/json'),
    authenticator(false, 'events:read'),
    async (ctx) => {
      const { id } = ctx.params;

      const [event] = await pool.query<{ id: string }[]>(
        sql`SELECT id FROM event WHERE id = ${id}`,
      );

      if (!event) {
        ctx.throw(404, 'no such event');
      }

      const rows = RowSchema.array().parse(
        await pool.query<unknown>(
          sql`SELECT p.userId, u.name, u.picture IS NOT NULL AS hasPicture,
              (u.premiumExpiration IS NOT NULL AND u.premiumExpiration > NOW()) AS premium,
              p.status, p.createdAt
            FROM eventParticipant p JOIN user u ON u.id = p.userId
            WHERE p.eventId = ${id}
            ORDER BY p.status = 'going' DESC, p.createdAt, p.userId`,
        ),
      );

      ctx.body = ParticipantSchema.array().parse(
        rows.map(
          ({ userId, name, hasPicture, premium, status, createdAt }) => ({
            user: { id: userId, name, hasPicture, premium },
            status,
            createdAt,
          }),
        ),
      );
    },
  );
}
