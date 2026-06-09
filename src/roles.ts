import z from 'zod';
import type { User } from './koaTypes.js';

/** Granular authorization roles, replacing the former single `isAdmin` flag. */
export const ROLES = [
  'userManager', // user administration: patch users, search/get/merge accounts
  'galleryModerator', // see private pictures, edit/delete any picture
  'mapModerator', // view/patch/delete any non-public map
  'trackingManager', // view/delete/modify any tracking device & token
  'layerPreview', // access to adminOnly (experimental/preview) map layers
] as const;

export const RoleSchema = z.enum(ROLES);

export type Role = z.infer<typeof RoleSchema>;

/** Whether the (possibly unauthenticated) user holds the given role. */
export function hasRole(user: User | undefined, role: Role): boolean {
  return Boolean(user?.roles.includes(role));
}

/**
 * Whether the user owns the resource (by user id) or holds the given role.
 * Encapsulates the common owner-or-moderator override pattern.
 */
export function isOwnerOrRole(
  user: User | undefined,
  ownerId: number,
  role: Role,
): boolean {
  return Boolean(user && (user.id === ownerId || hasRole(user, role)));
}
