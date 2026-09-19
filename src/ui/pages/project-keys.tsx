import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ErrorNote } from '../components/layout';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Input, Label, Select } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { api } from '../lib/api';
import { formatDate } from '../lib/utils';
import { type MemberRole, memberRole } from '../../db/schema';

const ROLE_HINT: Record<MemberRole, string> = {
  reader: 'read translations',
  editor: 'import resources, read translations',
  admin: 'also change project settings',
};

const CopyButton = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
    </Button>
  );
};

/** Shown once, right after minting: the platform keeps only a hash. */
const FreshToken = ({ name, token, slug }: { name: string; token: string; slug: string }) => (
  <div className="grid gap-2 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <span>
        Key <span className="font-medium">{name}</span> created. Copy it now — it will not be shown again.
      </span>
      <CopyButton value={token} />
    </div>
    <code className="break-all rounded bg-background px-2 py-1 font-mono text-xs">{token}</code>
    <pre className="overflow-x-auto rounded bg-background px-2 py-1 font-mono text-xs text-muted-foreground">
      {`LOQO_URL=${window.location.origin}\nLOQO_API_KEY=… # project "${slug}"`}
    </pre>
  </div>
);

export const ApiKeysDialog = ({ slug }: { slug: string }) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ name: string; role: MemberRole }>({ name: '', role: 'editor' });
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const keys = useQuery({ queryKey: ['keys', slug], queryFn: () => api.keys.list(slug), enabled: open });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['keys', slug] });
  const create = useMutation({
    mutationFn: () => api.keys.create(slug, form),
    onSuccess: ({ key, token }) => {
      setFresh({ name: key.name, token });
      setForm({ name: '', role: 'editor' });
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (id: string) => api.keys.remove(slug, id), onSuccess: refresh });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFresh(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <KeyRound /> API keys
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogTitle>API keys</DialogTitle>
        <DialogDescription>
          What your repo's sync step authenticates with. A key is bound to this project and one role; pass it to <code>createClient</code> from <code>@loqo/sdk</code>.
        </DialogDescription>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid min-w-56 flex-1 gap-1.5">
            <Label htmlFor="key-name">Name</Label>
            <Input id="key-name" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ci" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="key-role">Role</Label>
            <Select id="key-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as MemberRole })}>
              {memberRole.enumValues.map((role) => (
                <option key={role} value={role}>
                  {role} — {ROLE_HINT[role]}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" disabled={create.isPending}>
            Generate
          </Button>
        </form>
        <ErrorNote error={create.error ?? remove.error} />
        {fresh ? <FreshToken name={fresh.name} token={fresh.token} slug={slug} /> : null}
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead className="w-24">Role</TableHead>
                <TableHead className="w-40">Last used</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground">
                    No keys yet.
                  </TableCell>
                </TableRow>
              ) : null}
              {keys.data?.map((key) => (
                <TableRow key={key.id}>
                  <TableCell>
                    <div className="text-sm">{key.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">{key.prefix}…</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{key.role}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{key.lastUsedAt ? formatDate(key.lastUsedAt) : 'never'}</TableCell>
                  <TableCell>
                    <Button size="icon" variant="ghost" className="size-8" title="Revoke" onClick={() => remove.mutate(key.id)} disabled={remove.isPending}>
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
};
