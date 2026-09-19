import { DefaultTemplate } from '@payloadcms/next/templates';
import { Gutter } from '@payloadcms/ui';
import type { AdminViewServerProps } from 'payload';
// Through the package boundary, not the file: the client bundle must stay its own module with its `'use client'` directive.
import { TranslationStatus } from '@loqo/payload/client';

/** The `admin/loqo` view: the admin shell around `TranslationStatus`. The endpoints it calls need a signed-in user, so the view does too. */
export const TranslationStatusView = ({ initPageResult, params, searchParams }: AdminViewServerProps) => {
  const { payload, user } = initPageResult.req;
  if (!user) return <p>Sign in to see the translation status.</p>;

  return (
    <DefaultTemplate
      i18n={initPageResult.req.i18n}
      locale={initPageResult.locale}
      params={params}
      payload={payload}
      permissions={initPageResult.permissions}
      searchParams={searchParams}
      user={user}
      visibleEntities={initPageResult.visibleEntities}
    >
      <Gutter>
        <h1 style={{ marginBottom: 8 }}>Translations</h1>
        <TranslationStatus />
      </Gutter>
    </DefaultTemplate>
  );
};
