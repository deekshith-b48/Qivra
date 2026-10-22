import React from 'react';
import { View } from 'react-native';
import type { RootProps } from '../navigation/types';
import { emit } from '../services/events';
import { deleteLocalFiles } from '../services/capture';
import { getRepo } from '../services/db';
import { requestSync } from '../services/processing';
import { resolveConflict, type Resolution } from '../sync/engine';
import { Button, Card, EmptyState, Header, Screen, T } from '../ui/components';
import { useAction, useQuery } from '../ui/hooks';
import { space } from '../ui/theme';

function Field({ label, mine, theirs }: { label: string; mine: string; theirs: string }) {
  if (mine === theirs) return null;
  return (
    <View style={{ marginTop: space.sm }}>
      <T v="caption" color="textMuted">{label}</T>
      <T v="small">This phone: {mine || '—'}</T>
      <T v="small" color="info">Server: {theirs || '—'}</T>
    </View>
  );
}

export default function ConflictsScreen({ navigation }: RootProps<'Conflicts'>) {
  const { run } = useAction();
  const q = useQuery(async (repo) => {
    const list = await repo.openConflicts();
    return Promise.all(list.map(async (c) => ({ c, local: c.entityKind === 'item' ? await repo.getItem(c.entityId) : null })));
  }, ['conflicts', 'items']);

  const resolve = (id: string, choice: Resolution) => run(async () => {
    await deleteLocalFiles(await resolveConflict(await getRepo(), id, choice));
    emit('conflicts', 'items', 'collections');
    await requestSync();
  });

  return (
    <Screen>
      <Header title="Sync conflicts" subtitle="Edited on two devices. Nothing was overwritten — choose what to keep." onBack={() => navigation.goBack()} />
      {q.data?.length ? q.data.map(({ c, local }) => {
        const r = c.remote as Record<string, unknown>;
        return (
          <Card key={c.id} style={{ marginBottom: space.md }}>
            <T v="subtitle">{local?.title || String(r.title ?? r.name ?? c.entityId)}</T>
            {r.deleted === true ? (
              <T v="small" color="danger" style={{ marginTop: space.xs }}>Deleted on another device. "Keep server's" deletes it here too.</T>
            ) : local ? (
              <>
                <Field label="Title" mine={local.title} theirs={String(r.title ?? '')} />
                <Field label="Note" mine={local.note} theirs={String(r.note ?? '')} />
                <Field label="Tags" mine={local.tags.join(', ')} theirs={Array.isArray(r.tags) ? (r.tags as string[]).join(', ') : ''} />
                <Field label="Archived" mine={String(local.archived)} theirs={String(!!r.archived)} />
              </>
            ) : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.md }}>
              <Button title="Keep this phone's" kind="outline" onPress={() => void resolve(c.id, 'keep_local')} />
              <Button title="Keep server's" kind="outline" onPress={() => void resolve(c.id, 'keep_remote')} />
              {c.entityKind === 'item' ? <Button title="Keep both" onPress={() => void resolve(c.id, 'keep_both')} /> : null}
            </View>
          </Card>
        );
      }) : <EmptyState icon="git-compare-outline" title="No conflicts" body="When the same item is edited on two devices, both versions are kept here until you choose." />}
    </Screen>
  );
}
