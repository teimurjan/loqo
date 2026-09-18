import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNote } from '../../components/layout';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/input';
import { api } from '../../lib/api';
import { formatDate } from '../../lib/utils';

type Props = { promptId: string; version: number; body: string; readOnly: boolean; onPublished: () => void };

/** Body edits always publish a new version; the version list doubles as the rollback path. */
export const PromptEditor = ({ promptId, version, body: current, readOnly, onPublished }: Props) => {
  const [body, setBody] = useState(current);
  const [showVersions, setShowVersions] = useState(false);
  const versions = useQuery({ queryKey: ['prompt-versions', promptId], queryFn: () => api.prompts.versions(promptId), enabled: showVersions });
  const publish = useMutation({
    mutationFn: () => api.prompts.addVersion(promptId, body),
    onSuccess: () => {
      onPublished();
      void versions.refetch();
    },
  });
  const dirty = body !== current;
  return (
    <div className="grid gap-2">
      <Textarea
        className="font-mono text-xs"
        rows={Math.min(24, Math.max(6, body.split('\n').length + 1))}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        readOnly={readOnly}
      />
      <div className="flex flex-wrap items-center gap-2">
        {dirty && !readOnly ? (
          <>
            <Button size="sm" onClick={() => publish.mutate()} disabled={publish.isPending}>
              Publish as v{version + 1}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setBody(current)}>
              Discard
            </Button>
          </>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setShowVersions((value) => !value)}>
          {showVersions ? 'Hide versions' : 'Versions'}
        </Button>
      </div>
      <ErrorNote error={publish.error} />
      {showVersions && versions.data ? (
        <div className="grid gap-1 text-xs">
          {versions.data.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2">
              <Badge variant="muted">v{entry.version}</Badge>
              <span className="text-muted-foreground">{formatDate(entry.createdAt)}</span>
              {entry.version !== version && !readOnly ? (
                <Button size="sm" variant="link" className="h-auto p-0" onClick={() => setBody(entry.body)}>
                  load into editor
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
