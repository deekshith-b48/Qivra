import React, { useState } from 'react';
import { View } from 'react-native';
import type { RootProps } from '../navigation/types';
import { getRepo } from '../services/db';
import { emit } from '../services/events';
import { Button, Card, EmptyState, Field, Header, IconButton, Screen, Sheet, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { space, useTheme } from '../ui/theme';

export default function CollectionsScreen({ navigation }: RootProps<'Collections'>) {
  const { c } = useTheme();
  const q = useQuery((repo) => repo.listCollections(), ['collections', 'items']);
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null);
  const { busy, run } = useAction();

  const save = () => run(async () => {
    if (!editing?.name.trim()) return;
    const repo = await getRepo();
    if (editing.id) await repo.renameCollection(editing.id, editing.name);
    else await repo.createCollection(editing.name);
    emit('collections');
    setEditing(null);
  });

  return (
    <Screen>
      <Header title="Collections" onBack={() => navigation.goBack()} actions={<IconButton icon="add" label="New collection" onPress={() => setEditing({ id: null, name: '' })} />} />
      {q.data?.length ? q.data.map((col) => (
        <Card key={col.id} onPress={() => navigation.navigate('Main', { screen: 'Library', params: { collectionId: col.id } })} label={`${col.name}, ${col.itemCount} items`} style={{ marginBottom: space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T v="subtitle">{col.name}</T>
              <T v="caption" color="textMuted">{col.itemCount} item(s){col.syncStatus === 'pending' ? ' · not synced yet' : ''}</T>
            </View>
            <IconButton icon="pencil-outline" label={`Rename ${col.name}`} onPress={() => setEditing({ id: col.id, name: col.name })} />
            <IconButton icon="trash-outline" label={`Delete ${col.name}`} color={c.danger} onPress={() => void run(async () => {
              if (!(await confirm(`Delete “${col.name}”?`, 'Items stay in your library; only the collection is removed.', 'Delete', true))) return;
              await (await getRepo()).deleteCollection(col.id);
              emit('collections', 'items');
            })} />
          </View>
        </Card>
      )) : <EmptyState icon="folder-open-outline" title="No collections yet" body="Group related items — e.g. “Claude Code”, “System design”, “Read later”." action={<Button title="Create collection" icon="add" onPress={() => setEditing({ id: null, name: '' })} />} />}
      <Sheet visible={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Rename collection' : 'New collection'}>
        <Field label="Name" value={editing?.name ?? ''} onChangeText={(t) => setEditing((e) => (e ? { ...e, name: t } : e))} autoFocus maxLength={120} />
        <Button title="Save" onPress={() => void save()} loading={busy} disabled={!editing?.name.trim()} />
      </Sheet>
    </Screen>
  );
}
