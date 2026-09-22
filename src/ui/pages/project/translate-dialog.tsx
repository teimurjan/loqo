import { useMutation } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { ErrorNote } from '../../components/layout';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { api } from '../../lib/api';
import type { ProjectCounts } from '../../../core/projects/service';
import type { TargetStatus } from '../../../db/schema';

const CHOICES = [
  { id: 'missing', label: 'Missing translations', hint: 'Targets never translated, or whose last attempt failed.', statuses: ['pending', 'failed'] },
  { id: 'rejected', label: 'Rejected translations', hint: 'Targets whose value the guards refused.', statuses: ['rejected'] },
] as const satisfies readonly { id: string; label: string; hint: string; statuses: TargetStatus[] }[];

type Choice = (typeof CHOICES)[number]['id'];

const countOf = (counts: ProjectCounts, statuses: readonly TargetStatus[]) => statuses.reduce((sum, status) => sum + (counts.targets[status] ?? 0), 0);

type TranslateDialogProps = { slug: string; counts: ProjectCounts; onQueued: (enqueued: number) => void };

export const TranslateDialog = ({ slug, counts, onQueued }: TranslateDialogProps) => {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>('missing');
  const translate = useMutation({
    mutationFn: (statuses: TargetStatus[]) => api.projects.translate(slug, { statuses }),
    onSuccess: ({ enqueued }) => {
      setOpen(false);
      onQueued(enqueued);
    },
  });
  const selected = CHOICES.find((option) => option.id === choice) ?? CHOICES[0];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Play /> Translate
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Translate</DialogTitle>
        <DialogDescription>Pinned and skipped targets are never queued.</DialogDescription>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            translate.mutate([...selected.statuses]);
          }}
        >
          <div className="grid gap-2">
            {CHOICES.map((option) => (
              <label
                key={option.id}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:checked]:bg-accent/40"
              >
                <input type="radio" name="translate-choice" className="mt-1" checked={choice === option.id} onChange={() => setChoice(option.id)} />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">
                    {option.label} <span className="tabular-nums text-muted-foreground">{countOf(counts, option.statuses)}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <ErrorNote error={translate.error} />
          <div className="flex justify-end">
            <Button type="submit" disabled={translate.isPending || countOf(counts, selected.statuses) === 0}>
              Translate
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};
