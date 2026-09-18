import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Empty, ErrorNote, PageHeader } from '../components/layout';
import { StatusBadge } from '../components/status';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Input, Label } from '../components/ui/input';
import { api } from '../lib/api';
import type { TargetStatus } from '../../db/schema';

const STATUS_ORDER: TargetStatus[] = ['pending', 'queued', 'translating', 'translated', 'rejected', 'failed', 'skipped'];

const CreateProjectDialog = () => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ slug: '', name: '', sourceLocale: 'en', targetLocales: '' });
  const create = useMutation({
    mutationFn: () =>
      api.projects.create({
        slug: form.slug,
        name: form.name,
        sourceLocale: form.sourceLocale,
        targetLocales: form.targetLocales.split(/[\s,]+/).filter(Boolean),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      setOpen(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus /> New project
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>New project</DialogTitle>
        <DialogDescription>A project is one content store. Its repo imports resources and applies translations with a project API key.</DialogDescription>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="slug">Slug</Label>
            <Input id="slug" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="ios" required pattern="[a-z0-9-]+" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Mobile app" required />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="source">Source</Label>
              <Input id="source" value={form.sourceLocale} onChange={(e) => setForm({ ...form, sourceLocale: e.target.value })} required />
            </div>
            <div className="col-span-2 grid gap-1.5">
              <Label htmlFor="targets">Target locales</Label>
              <Input id="targets" value={form.targetLocales} onChange={(e) => setForm({ ...form, targetLocales: e.target.value })} placeholder="de, fr, pl" />
            </div>
          </div>
          <ErrorNote error={create.error} />
          <div className="flex justify-end">
            <Button type="submit" disabled={create.isPending}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export const ProjectsPage = () => {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects.list, refetchInterval: 5000 });

  return (
    <>
      <PageHeader title="Projects" description="Each project is a content store synced into the canonical resource model." actions={<CreateProjectDialog />} />
      <ErrorNote error={projects.error} />
      {projects.data?.length === 0 ? <Empty>No projects yet. Create one, generate an API key, and import from its repo.</Empty> : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {projects.data?.map((project) => (
          <Link key={project.id} to={`/projects/${project.slug}`} className="block">
            <Card className="h-full transition-colors hover:bg-accent/40">
              <CardHeader>
                <CardTitle>{project.name}</CardTitle>
                <CardDescription>
                  {project.slug} · {project.sourceLocale} → {project.targetLocales.join(', ') || 'no targets'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{project.counts.resources} resources</span>
                {STATUS_ORDER.filter((status) => project.counts.targets[status]).map((status) => (
                  <span key={status} className="inline-flex items-center gap-1">
                    <StatusBadge status={status} />
                    <span className="text-muted-foreground">{project.counts.targets[status]}</span>
                  </span>
                ))}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
};
