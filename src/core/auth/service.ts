import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { type User, projectMembers, users } from '../../db/schema';
import type { GoogleProfile } from './google';

export const findUserByEmail = async (db: Db, email: string): Promise<User | null> => {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return user ?? null;
};

/** Upserts the Google identity and links any pending invites for that email. */
export const signIn = (db: Db, profile: GoogleProfile): Promise<User> =>
  db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ googleSub: profile.sub, email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl })
      .onConflictDoUpdate({
        target: users.googleSub,
        set: { email: profile.email, name: profile.name, avatarUrl: profile.avatarUrl, updatedAt: new Date() },
      })
      .returning();
    if (!user) throw new Error('upsert returned no row');

    await tx
      .update(projectMembers)
      .set({ userId: user.id, acceptedAt: new Date() })
      .where(and(eq(projectMembers.email, user.email), isNull(projectMembers.userId)));
    return user;
  });
