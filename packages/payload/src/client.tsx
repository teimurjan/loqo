'use client';

import type { StatusCounts, SyncSummary, TargetStatus } from '@loqo/sdk';
import { Button, toast, useConfig, useDocumentInfo } from '@payloadcms/ui';
import { useCallback, useEffect, useState } from 'react';
import type { DocumentStatus, ProjectStatus } from './service';

/**
 * The plugin's admin pieces, talking to its own `/api/loqo/*` endpoints: translate/apply
 * controls on a document's edit view, and a project-wide status table for the `loqo` view.
 * Kept free of styling beyond Payload's own elements so they sit in any admin theme.
 */

const STATUS_ORDER: TargetStatus[] = ['translated', 'pending', 'queued', 'translating', 'rejected', 'failed', 'skipped'];

const sum = (counts: StatusCounts, statuses: readonly TargetStatus[]): number => statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);

const summarize = (counts: StatusCounts): string =>
  STATUS_ORDER.filter((status) => counts[status])
    .map((status) => `${counts[status]} ${status}`)
    .join(' · ') || 'nothing translated yet';

type Failure = { error?: string };

const useApi = () => {
  const { config } = useConfig();
  const base = `${config.serverURL ?? ''}${config.routes.api}/loqo`;
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(`${base}${path}`, { credentials: 'include', ...init });
      const body = (await response.json().catch(() => ({}))) as T & Failure;
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      return body;
    },
    [base],
  );
};

const documentPath = (info: { collectionSlug?: string; globalSlug?: string; id?: number | string }): string | null => {
  if (info.globalSlug) return `/globals/${encodeURIComponent(info.globalSlug)}`;
  if (info.collectionSlug && info.id !== undefined) return `/collections/${encodeURIComponent(info.collectionSlug)}/${encodeURIComponent(String(info.id))}`;
  return null;
};

/** Before the document controls: where this document's translations stand, and the two things an editor can do about it. */
export const TranslateControls = () => {
  const info = useDocumentInfo();
  const api = useApi();
  const path = documentPath(info);
  const [status, setStatus] = useState<DocumentStatus | null>(null);
  const [busy, setBusy] = useState<'translate' | 'apply' | null>(null);

  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      setStatus(await api<DocumentStatus>(`${path}/status`));
    } catch {
      setStatus(null);
    }
  }, [api, path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!path) return null;

  const run = async (action: 'translate' | 'apply') => {
    setBusy(action);
    try {
      if (action === 'translate') {
        const summary = await api<SyncSummary>(`${path}/translate`, { method: 'POST' });
        toast.success(`Sent to translation: ${summary.enqueued} queued, ${summary.created + summary.updated} changed.`);
      } else {
        const applied = await api<{ pushed: { written: number; rejected?: { reason: string }[] } }>(`${path}/apply`, { method: 'POST' });
        const rejected = applied.pushed.rejected?.length ?? 0;
        toast.success(`Applied ${applied.pushed.written} translated values${rejected ? `, ${rejected} refused` : ''}. Reload to see them.`);
      }
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  const total: StatusCounts = {};
  for (const counts of Object.values(status?.locales ?? {})) for (const [key, value] of Object.entries(counts)) total[key as TargetStatus] = (total[key as TargetStatus] ?? 0) + value;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: 'var(--theme-elevation-600)' }}>{status ? summarize(total) : 'Translation status unavailable'}</span>
      <Button size="small" buttonStyle="secondary" disabled={busy !== null} onClick={() => void run('translate')}>
        {busy === 'translate' ? 'Sending…' : 'Translate'}
      </Button>
      <Button size="small" buttonStyle="secondary" disabled={busy !== null || sum(total, ['translated']) === 0} onClick={() => void run('apply')}>
        {busy === 'apply' ? 'Applying…' : 'Apply translations'}
      </Button>
    </div>
  );
};

const POLL_MS = 15_000;

type Row = ProjectStatus['collections'][number];

const RowLine = ({ row }: { row: Row }) => (
  <tr>
    <td style={{ padding: '6px 12px 6px 0' }}>{row.slug}</td>
    <td style={{ padding: '6px 12px 6px 0', color: 'var(--theme-elevation-600)' }}>{row.applied ? 'writes back' : 'imports only'}</td>
    {STATUS_ORDER.map((status) => (
      <td key={status} style={{ padding: '6px 12px 6px 0', textAlign: 'right', color: row.counts[status] ? undefined : 'var(--theme-elevation-400)' }}>
        {row.counts[status] ?? 0}
      </td>
    ))}
  </tr>
);

/** The `loqo` admin view's body: every listed collection and global with its targets by status, and the project-wide actions. */
export const TranslationStatus = () => {
  const api = useApi();
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api<ProjectStatus>('/status'));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Request failed');
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (label: string, path: string, describe: (result: never) => string) => {
    setBusy(label);
    try {
      const result = await api<never>(path, { method: 'POST' });
      toast.success(describe(result));
      await refresh();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Request failed');
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p>Translation status unavailable: {error}</p>;
  if (!status) return <p>Loading…</p>;

  const open = sum(status.project.counts, ['pending', 'queued', 'translating', 'rejected', 'failed']);

  return (
    <div>
      <p style={{ color: 'var(--theme-elevation-600)' }}>
        Project <strong>{status.project.slug}</strong>: {status.project.sourceLocale} → {status.project.targetLocales.length} locales, {summarize(status.project.counts)}.
      </p>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0 20px', flexWrap: 'wrap' }}>
        <Button size="small" buttonStyle="secondary" disabled={busy !== null} onClick={() => void run('import', '/import', (summary: SyncSummary) => `Imported: ${summary.created} new, ${summary.updated} changed, ${summary.removed} removed, ${summary.enqueued} queued.`)}>
          {busy === 'import' ? 'Importing…' : 'Import everything'}
        </Button>
        <Button size="small" buttonStyle="secondary" disabled={busy !== null || open === 0} onClick={() => void run('translate', '/translate', (result: { enqueued: number }) => `Queued ${result.enqueued} targets.`)}>
          {busy === 'translate' ? 'Queuing…' : 'Translate missing'}
        </Button>
        <Button size="small" buttonStyle="secondary" disabled={busy !== null} onClick={() => void run('sync', '/sync', (result: { applied: { pushed: { written: number } } }) => `Applied ${result.applied.pushed.written} translated values.`)}>
          {busy === 'sync' ? 'Syncing…' : 'Import and apply'}
        </Button>
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ color: 'var(--theme-elevation-600)', textAlign: 'left' }}>
            <th style={{ padding: '6px 12px 6px 0', fontWeight: 500 }}>Entity</th>
            <th style={{ padding: '6px 12px 6px 0', fontWeight: 500 }}>Mode</th>
            {STATUS_ORDER.map((name) => (
              <th key={name} style={{ padding: '6px 12px 6px 0', fontWeight: 500, textAlign: 'right' }}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {status.collections.map((row) => (
            <RowLine key={`collection:${row.slug}`} row={row} />
          ))}
          {status.globals.map((row) => (
            <RowLine key={`global:${row.slug}`} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
};
