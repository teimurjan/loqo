import type { MemberRole } from '../../db/schema';

export const ROLE_RANK: Record<MemberRole, number> = { reader: 0, editor: 1, admin: 2 };

export const hasRole = (actual: MemberRole, min: MemberRole): boolean => ROLE_RANK[actual] >= ROLE_RANK[min];
