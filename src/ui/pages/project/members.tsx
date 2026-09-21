import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ErrorNote } from '../../components/layout';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input, Label, Select } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { api } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { type MemberRole, memberRole } from '../../../db/schema';

const ROLE_HINT: Record<MemberRole, string> = {
  admin: 'settings, members, flows',
  editor: 'pin, edit, re-translate, import',
  reader: 'view only',
};

export const MembersSection = ({ slug }: { slug: string }) => {
  const me = useMe();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ email: string; role: MemberRole }>({ email: '', role: 'editor' });
  const members = useQuery({ queryKey: ['members', slug], queryFn: () => api.members.list(slug) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['members', slug] });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };
  const invite = useMutation({
    mutationFn: () => api.members.invite(slug, form),
    onSuccess: () => {
      setForm({ email: '', role: 'editor' });
      refresh();
    },
  });
  const setRole = useMutation({ mutationFn: ({ id, role }: { id: string; role: MemberRole }) => api.members.setRole(slug, id, role), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => api.members.remove(slug, id), onSuccess: refresh });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members</CardTitle>
        <CardDescription>Invite by Google account email. An invite stays pending until that person signs in.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate();
          }}
        >
          <div className="grid min-w-56 flex-1 gap-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.com" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <Select id="invite-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as MemberRole })}>
              {memberRole.enumValues.map((role) => (
                <option key={role} value={role}>
                  {role} — {ROLE_HINT[role]}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={invite.isPending}>
            Invite
          </Button>
        </form>
        <ErrorNote error={invite.error ?? setRole.error ?? remove.error} />
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead className="w-32">Role</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.data?.map((member) => (
                <TableRow key={member.id}>
                  <TableCell>
                    <div className="text-sm">{member.user?.name ?? member.email}</div>
                    {member.user ? <div className="text-xs text-muted-foreground">{member.email}</div> : null}
                  </TableCell>
                  <TableCell>
                    <Select className="h-8 w-full" value={member.role} onChange={(e) => setRole.mutate({ id: member.id, role: e.target.value as MemberRole })}>
                      {memberRole.enumValues.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>{member.userId ? <Badge variant="success">active</Badge> : <Badge variant="warning">pending</Badge>}</TableCell>
                  <TableCell>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      title={member.userId === me.user?.id ? 'Leave project' : 'Remove'}
                      onClick={() => remove.mutate(member.id)}
                      disabled={remove.isPending}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
};
