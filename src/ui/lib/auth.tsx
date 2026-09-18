import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext } from 'react';
import type { MemberRole } from '../../db/schema';
import { hasRole } from '../../core/members/roles';
import { api, type Me } from './api';

export const ME_KEY = ['me'] as const;

export const useMeQuery = () =>
  useQuery({
    queryKey: ME_KEY,
    queryFn: api.auth.me,
    retry: false,
    staleTime: 60_000,
  });

const MeContext = createContext<Me | null>(null);

export const MeProvider = ({ me, children }: { me: Me; children: ReactNode }) => <MeContext.Provider value={me}>{children}</MeContext.Provider>;

export const useMe = (): Me => {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside MeProvider');
  return me;
};

/** The caller's role on a project, or `null` when they are not a member. */
export const useProjectRole = (slug: string | undefined): MemberRole | null => {
  const me = useMe();
  return me.memberships.find((membership) => membership.projectSlug === slug)?.role ?? null;
};

export const useCan = (slug: string | undefined, min: MemberRole): boolean => {
  const role = useProjectRole(slug);
  return role !== null && hasRole(role, min);
};

export const useSignOut = () => {
  const queryClient = useQueryClient();
  return async () => {
    await api.auth.logout();
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
  };
};
