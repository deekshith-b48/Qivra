import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { rangeFor } from '../core/dates';
import { languageName } from '../core/language';
import type { LibraryFilter, SortKey } from '../core/search';
import { ALL_STATUSES, STATUS_LABELS, type ItemStatus } from '../core/status';
import { SOURCE_LABELS, type SourceType } from '../core/url';
import type { Item } from '../db/types';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { deleteItemFiles } from '../services/capture';
import { getRepo } from '../services/db';
import { emit, subscribe } from '../services/events';
import { generateReport } from '../services/reports';
import { updateSettings } from '../services/settings';
import { Banner, Button, Chip, EmptyState, Fab, IconButton, Loading, Sheet, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { ItemCard } from '../ui/ItemCard';
import { radius, space, type, useTheme } from '../ui/theme';
import { useSettings } from '../ui/useSettings';

type Props = CompositeScreenProps<BottomTabScreenProps<TabParamList, 'Library'>, NativeStackScreenProps<RootStackParamList>>;
const PAGE = 30;
const SORTS: [SortKey, string][] = [['newest', 'Newest'], ['oldest', 'Oldest'], ['updated', 'Recently updated'], ['title', 'Title A–Z']];
const DATES: [string, string][] = [['any', 'Any time'], ['today', 'Today'], ['week', 'Last 7 days'], ['last30', 'Last 30 days']];

export default function LibraryScreen({ navigation, route }: Props) {
  const { c } = useTheme();
  const settings = useSettings();
  const tz = settings?.timezone ?? 'UTC';
  const grid = settings?.libraryView === 'grid';
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const [sources, setSources] = useState<SourceType[]>([]);
  const [statuses, setStatuses] = useState<ItemStatus[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [date, setDate] = useState('any');
  const [collectionId, setCollectionId] = useState<string | undefined>(route.params?.collectionId);
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [end, setEnd] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const { busy, run } = useAction();

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => setCollectionId(route.params?.collectionId), [route.params?.collectionId]);

  const filter: LibraryFilter = useMemo(() => {
    const f: LibraryFilter = { text: debounced, sourceTypes: sources, statuses, languages, tags, collectionId, archived };
    if (date !== 'any') {
      const r = rangeFor(date as 'today' | 'week' | 'last30', Date.now(), tz);
      f.fromIso = r.startIso;
      f.toIso = r.endIso;
    }
    return f;
  }, [debounced, sources, statuses, languages, tags, collectionId, archived, date, tz]);

  const load = useCallback(async (reset: boolean) => {
    try {
      setLoading(true);
      const repo = await getRepo();
      const offset = reset ? 0 : items.length;
      const page = await repo.listItems(filter, sort, PAGE, offset);
      setItems((prev) => (reset ? page : [...prev, ...page.filter((p) => !prev.some((x) => x.id === p.id))]));
      setEnd(page.length < PAGE);
      if (reset) setTotal(await repo.countItems(filter));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, sort, items.length]);

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, sort]);
  useEffect(() => subscribe((t) => {
    if (t === 'items' || t === 'collections') void load(true);
  }), [load]);

  const facets = useQuery(async (repo) => ({
    tags: (await repo.allTags()).slice(0, 30),
    languages: (await repo.db.all<{ language: string }>(`SELECT DISTINCT language FROM items WHERE deleted = 0 AND language != 'und'`)).map((r) => r.language),
    collections: await repo.listCollections(),
  }), ['items', 'collections']);

  const toggle = <T,>(list: T[], v: T, set: (x: T[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const activeFilters = sources.length + statuses.length + languages.length + tags.length + (date !== 'any' ? 1 : 0) + (collectionId ? 1 : 0);
  const selecting = selected.size > 0;
  const ids = [...selected];

  const bulk = {
    archive: () => run(async () => {
      const repo = await getRepo();
      await repo.setArchived(ids, !archived);
      setSelected(new Set());
      emit('items');
    }),
    delete: () => run(async () => {
      if (!(await confirm(`Delete ${ids.length} item(s)?`, 'Transcripts, notes and attached media on this phone are deleted. Synced items are deleted on your server at the next sync.', 'Delete', true))) return;
      const repo = await getRepo();
      await deleteItemFiles(ids);
      await repo.deleteItems(ids);
      setSelected(new Set());
      emit('items');
    }),
    collect: (colId: string) => run(async () => {
      const repo = await getRepo();
      await repo.addToCollection(colId, ids);
      setSelected(new Set());
      setCollectOpen(false);
      emit('items', 'collections');
    }),
  };

  const collectionName = facets.data?.collections.find((x) => x.id === collectionId)?.name;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.sm, minHeight: 56 }}>
        {selecting ? (
          <>
            <IconButton icon="close" label="Clear selection" onPress={() => setSelected(new Set())} />
            <T v="title" style={{ flex: 1 }}>{selected.size} selected</T>
            <IconButton icon="document-text-outline" label="Report on selected items" onPress={() => void run(async () => {
              const r = await generateReport({ kind: 'selection', itemIds: ids, useAi: settings?.ai.enabled });
              setSelected(new Set());
              navigation.navigate('ReportDetail', { id: r.id });
            }, 'Report failed')} />
            <IconButton icon="folder-outline" label="Add to collection" onPress={() => setCollectOpen(true)} />
            <IconButton icon={archived ? 'arrow-undo-outline' : 'archive-outline'} label={archived ? 'Restore' : 'Archive'} onPress={() => void bulk.archive()} />
            <IconButton icon="trash-outline" label="Delete" color={c.danger} onPress={() => void bulk.delete()} />
          </>
        ) : (
          <>
            <T v="title" style={{ flex: 1 }} accessibilityRole="header">{archived ? 'Archive' : collectionName ?? 'Library'}</T>
            <IconButton icon={grid ? 'list-outline' : 'grid-outline'} label={grid ? 'List view' : 'Grid view'} onPress={() => void updateSettings({ libraryView: grid ? 'list' : 'grid' })} />
            <IconButton icon={archived ? 'albums-outline' : 'archive-outline'} label={archived ? 'Show library' : 'Show archive'} onPress={() => setArchived(!archived)} />
            <IconButton icon="settings-outline" label="Settings" onPress={() => navigation.navigate('Settings')} />
          </>
        )}
      </View>
      <View style={{ paddingHorizontal: space.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, paddingLeft: space.md }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Filter your library"
            placeholderTextColor={c.textFaint}
            accessibilityLabel="Filter your library"
            style={[type.body, { flex: 1, color: c.text, minHeight: 48 }]}
            returnKeyType="search"
          />
          {text ? <IconButton icon="close-circle" label="Clear text" onPress={() => setText('')} color={c.textMuted} /> : null}
          <IconButton icon="options-outline" label={`Filters${activeFilters ? `, ${activeFilters} active` : ''}`} onPress={() => setFiltersOpen(true)} />
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.sm, flexWrap: 'wrap' }}>
          <T v="caption" color="textMuted" style={{ marginRight: space.sm }}>{total} item{total === 1 ? '' : 's'}</T>
          {collectionName ? <Chip label={collectionName} selected onPress={() => setCollectionId(undefined)} /> : null}
          {activeFilters ? <Chip label={`${activeFilters} filter(s)`} tone="accent" onPress={() => setFiltersOpen(true)} /> : null}
        </View>
      </View>
      {error ? <View style={{ paddingHorizontal: space.lg }}><Banner tone="danger" title="Couldn't load library" body={error} action={<Button kind="outline" title="Retry" onPress={() => void load(true)} />} /></View> : null}
      <FlatList
        key={grid ? 'grid' : 'list'}
        data={items}
        numColumns={grid ? 2 : 1}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: space.lg, paddingBottom: 96 }}
        renderItem={({ item }) => (
          <ItemCard
            item={item}
            grid={grid}
            timezone={tz}
            selected={selected.has(item.id)}
            onPress={() => (selecting ? setSelected((s) => { const n = new Set(s); n.has(item.id) ? n.delete(item.id) : n.add(item.id); return n; }) : navigation.navigate('ItemDetail', { id: item.id }))}
            onLongPress={() => setSelected((s) => new Set(s).add(item.id))}
          />
        )}
        onEndReached={() => { if (!end && !loading) void load(false); }}
        onEndReachedThreshold={0.4}
        initialNumToRender={10}
        windowSize={7}
        removeClippedSubviews
        refreshing={false}
        onRefresh={() => void load(true)}
        ListFooterComponent={loading ? <Loading /> : null}
        ListEmptyComponent={!loading ? (
          debounced || activeFilters ? (
            <EmptyState icon="search-outline" title="No matches" body="Try fewer filters or different words." action={<Button kind="outline" title="Clear filters" onPress={() => { setText(''); setSources([]); setStatuses([]); setLanguages([]); setTags([]); setDate('any'); setCollectionId(undefined); }} />} />
          ) : archived ? (
            <EmptyState icon="archive-outline" title="Archive is empty" body="Archived items are hidden from the library but kept and searchable here." />
          ) : (
            <EmptyState icon="library-outline" title="Your library is empty" body="Share links, notes or transcript files to Qivra, or add one now." action={<Button title="Save something" icon="add" onPress={() => navigation.navigate('Capture')} />} />
          )
        ) : null}
      />
      {!selecting ? <Fab label="Save" icon="add" onPress={() => navigation.navigate('Capture')} /> : null}

      <Sheet visible={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filter & sort">
        <T v="caption" color="textMuted">Sort</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.sm }}>
          {SORTS.map(([k, l]) => <Chip key={k} label={l} selected={sort === k} onPress={() => setSort(k)} />)}
        </View>
        <T v="caption" color="textMuted">Saved</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.sm }}>
          {DATES.map(([k, l]) => <Chip key={k} label={l} selected={date === k} onPress={() => setDate(k)} />)}
        </View>
        <T v="caption" color="textMuted">Source</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.sm }}>
          {(Object.keys(SOURCE_LABELS) as SourceType[]).map((s) => <Chip key={s} label={SOURCE_LABELS[s]} selected={sources.includes(s)} onPress={() => toggle(sources, s, setSources)} />)}
        </View>
        <T v="caption" color="textMuted">Processing status</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.sm }}>
          {ALL_STATUSES.map((s) => <Chip key={s} label={STATUS_LABELS[s]} selected={statuses.includes(s)} onPress={() => toggle(statuses, s, setStatuses)} />)}
        </View>
        {facets.data?.languages.length ? (
          <>
            <T v="caption" color="textMuted">Language</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.sm }}>
              {facets.data.languages.map((l) => <Chip key={l} label={languageName(l)} selected={languages.includes(l)} onPress={() => toggle(languages, l, setLanguages)} />)}
            </View>
          </>
        ) : null}
        {facets.data?.tags.length ? (
          <>
            <T v="caption" color="textMuted">Tags</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.sm }}>
              {facets.data.tags.map((t) => <Chip key={t.tag} label={`${t.tag} · ${t.count}`} selected={tags.includes(t.tag)} onPress={() => toggle(tags, t.tag, setTags)} />)}
            </View>
          </>
        ) : null}
        {facets.data?.collections.length ? (
          <>
            <T v="caption" color="textMuted">Collection</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.sm }}>
              {facets.data.collections.map((col) => <Chip key={col.id} label={col.name} selected={collectionId === col.id} onPress={() => setCollectionId(collectionId === col.id ? undefined : col.id)} />)}
            </View>
          </>
        ) : null}
        <Button title="Show results" onPress={() => setFiltersOpen(false)} style={{ marginTop: space.md }} />
      </Sheet>

      <Sheet visible={collectOpen} onClose={() => setCollectOpen(false)} title="Add to collection">
        {facets.data?.collections.length ? facets.data.collections.map((col) => (
          <Button key={col.id} kind="outline" title={`${col.name} (${col.itemCount})`} onPress={() => void bulk.collect(col.id)} style={{ marginBottom: space.sm }} />
        )) : <T color="textMuted">No collections yet. Create one from Collections.</T>}
        <Button kind="text" title="Manage collections" onPress={() => { setCollectOpen(false); navigation.navigate('Collections'); }} />
      </Sheet>
      {busy ? <View style={{ position: 'absolute', top: 0, left: 0, right: 0 }}><Loading label="Working" /></View> : null}
    </SafeAreaView>
  );
}
