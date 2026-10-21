import React, { useState } from 'react';
import { View } from 'react-native';
import { describeRules, rulesToFilter, sanitizeRules, type SmartRules } from '../core/smart';
import type { ItemStatus } from '../core/status';
import { SOURCE_LABELS, type SourceType } from '../core/url';
import type { RootProps } from '../navigation/types';
import { getRepo } from '../services/db';
import { emit } from '../services/events';
import { Button, Card, Chip, EmptyState, Field, Header, IconButton, Screen, Section, Sheet, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { space, useTheme } from '../ui/theme';

const SOURCES: SourceType[] = ['youtube', 'instagram', 'x', 'podcast', 'web', 'github', 'note', 'file'];
const STATUSES: { status: ItemStatus; label: string }[] = [
  { status: 'READY', label: 'Ready' },
  { status: 'NEEDS_INPUT', label: 'Needs input' },
  { status: 'FAILED_RETRYABLE', label: 'Failed' },
];

const toggle = <T,>(list: T[] | undefined, v: T): T[] | undefined => {
  const next = list?.includes(v) ? list.filter((x) => x !== v) : [...(list ?? []), v];
  return next.length ? next : undefined;
};

/** Rule builder for a new smart collection, with a live count of matching items. */
function SmartBuilder({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [rules, setRules] = useState<SmartRules>({});
  const { busy, run } = useAction();
  const options = useQuery(async (repo) => ({ tags: (await repo.allTags()).slice(0, 12), concepts: await repo.topConcepts(12) }), ['items'], [visible]);
  const clean = sanitizeRules(rules);
  const count = useQuery((repo) => (clean ? repo.countItems(rulesToFilter(clean)) : Promise.resolve(0)), ['items'], [JSON.stringify(clean)]);
  const set = (patch: Partial<SmartRules>) => setRules((r) => ({ ...r, ...patch }));
  const close = () => {
    setName('');
    setRules({});
    onClose();
  };
  const save = () => run(async () => {
    if (!clean || !name.trim()) return;
    await (await getRepo()).createSmartCollection(name, clean);
    emit('collections');
    close();
  });

  return (
    <Sheet visible={visible} onClose={close} title="New smart collection">
      <Field label="Name" value={name} onChangeText={setName} maxLength={120} />
      <T v="caption" color="textMuted">Source</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {SOURCES.map((s) => <Chip key={s} label={SOURCE_LABELS[s]} selected={!!rules.sourceTypes?.includes(s)} onPress={() => set({ sourceTypes: toggle(rules.sourceTypes, s) })} />)}
      </View>
      <T v="caption" color="textMuted">Status</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {STATUSES.map((s) => <Chip key={s.status} label={s.label} selected={!!rules.statuses?.includes(s.status)} onPress={() => set({ statuses: toggle(rules.statuses, s.status) })} />)}
        <Chip label="Unread" selected={!!rules.unread} onPress={() => set({ unread: rules.unread ? undefined : true })} />
        {[7, 30].map((d) => (
          <Chip key={d} label={`Saved within ${d} days`} selected={rules.savedWithinDays === d} onPress={() => set({ savedWithinDays: rules.savedWithinDays === d ? undefined : d })} />
        ))}
      </View>
      {options.data?.tags.length ? (
        <>
          <T v="caption" color="textMuted">Tags</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {options.data.tags.map((t) => <Chip key={t.tag} label={`#${t.tag}`} selected={!!rules.tags?.includes(t.tag)} onPress={() => set({ tags: toggle(rules.tags, t.tag) })} />)}
          </View>
        </>
      ) : null}
      {options.data?.concepts.length ? (
        <>
          <T v="caption" color="textMuted">Concepts</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            {options.data.concepts.map((t) => <Chip key={t.concept} label={t.concept} selected={!!rules.concepts?.includes(t.concept)} onPress={() => set({ concepts: toggle(rules.concepts, t.concept) })} />)}
          </View>
        </>
      ) : null}
      <T v="small" color="textMuted" style={{ marginVertical: space.sm }} accessibilityLiveRegion="polite">
        {clean ? `${count.data ?? 0} matching item${count.data === 1 ? '' : 's'} · ${describeRules(clean)}` : 'Pick at least one rule.'}
      </T>
      <Button title="Create" icon="sparkles-outline" onPress={() => void save()} loading={busy} disabled={!clean || !name.trim()} />
    </Sheet>
  );
}

export default function CollectionsScreen({ navigation }: RootProps<'Collections'>) {
  const { c } = useTheme();
  const q = useQuery(async (repo) => ({ collections: await repo.listCollections(), suggestions: await repo.suggestCollections() }), ['collections', 'items']);
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null);
  const [building, setBuilding] = useState(false);
  const { busy, run } = useAction();
  const cols = q.data?.collections;

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
      <Header title="Collections" onBack={() => navigation.goBack()} actions={<>
        <IconButton icon="sparkles-outline" label="New smart collection" onPress={() => setBuilding(true)} />
        <IconButton icon="add" label="New collection" onPress={() => setEditing({ id: null, name: '' })} />
      </>} />
      {cols?.length ? cols.map((col) => (
        <Card key={col.id} onPress={() => navigation.navigate('Main', { screen: 'Library', params: { collectionId: col.id } })} label={`${col.rules ? 'Smart collection ' : ''}${col.name}, ${col.itemCount} items`} style={{ marginBottom: space.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <T v="subtitle">{col.rules ? '✨ ' : ''}{col.name}</T>
              <T v="caption" color="textMuted" numberOfLines={1}>
                {col.itemCount} item(s){col.rules ? ` · ${describeRules(col.rules)}` : ''}{col.syncStatus === 'pending' ? ' · not synced yet' : ''}
              </T>
            </View>
            <IconButton icon="school-outline" label={`Study ${col.name}`} onPress={() => navigation.navigate('Review', { collectionId: col.id })} />
            <IconButton icon="pencil-outline" label={`Rename ${col.name}`} onPress={() => setEditing({ id: col.id, name: col.name })} />
            <IconButton icon="trash-outline" label={`Delete ${col.name}`} color={c.danger} onPress={() => void run(async () => {
              if (!(await confirm(`Delete “${col.name}”?`, 'Items stay in your library; only the collection is removed.', 'Delete', true))) return;
              await (await getRepo()).deleteCollection(col.id);
              emit('collections', 'items');
            })} />
          </View>
        </Card>
      )) : q.data ? <EmptyState icon="folder-open-outline" title="No collections yet" body="Group related items — e.g. “Claude Code”, “System design”, “Read later”." action={<Button title="Create collection" icon="add" onPress={() => setEditing({ id: null, name: '' })} />} /> : null}

      {q.data?.suggestions.length ? (
        <Section title="Suggested">
          {q.data.suggestions.map((s) => (
            <Card key={`${s.kind}:${s.name}`} style={{ marginBottom: space.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <T v="subtitle">✨ {s.kind === 'tag' ? `#${s.name}` : s.name}</T>
                  <T v="caption" color="textMuted">{s.count} items share this {s.kind}</T>
                </View>
                <Button kind="tonal" title="Create" accessibilityHint={`Creates a smart collection for ${s.name}`} onPress={() => void run(async () => {
                  await (await getRepo()).createSmartCollection(s.name, s.rules);
                  emit('collections');
                })} />
              </View>
            </Card>
          ))}
        </Section>
      ) : null}

      <Sheet visible={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Rename collection' : 'New collection'}>
        <Field label="Name" value={editing?.name ?? ''} onChangeText={(t) => setEditing((e) => (e ? { ...e, name: t } : e))} autoFocus maxLength={120} />
        <Button title="Save" onPress={() => void save()} loading={busy} disabled={!editing?.name.trim()} />
      </Sheet>
      <SmartBuilder visible={building} onClose={() => setBuilding(false)} />
    </Screen>
  );
}
