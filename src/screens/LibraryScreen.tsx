import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import type { CompositeScreenProps } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { rangeFor } from '../core/dates';
import { languageName } from '../core/language';
import type { LibraryFilter, SortKey } from '../core/search';
import { ALL_STATUSES, STATUS_LABELS, type ItemStatus } from '../core/status';
import { NOTE_SOURCES, SOURCE_LABELS, VIDEO_SOURCES, WEBSITE_SOURCES, type SourceType } from '../core/url';
import type { Item } from '../db/types';
import type { RootStackParamList, TabParamList } from '../navigation/types';
import { deleteItemFiles } from '../services/capture';
import { getRepo } from '../services/db';
import { emit, subscribe } from '../services/events';
import { generateReport } from '../services/reports';
import { updateSettings } from '../services/settings';
import { Backdrop, Banner, Button, Chip, CircleButton, EmptyState, IconButton, type IconName, Loading, Row, Sheet, Snackbar, T } from '../ui/components';
import { confirm, useAction, useQuery } from '../ui/hooks';
import { ItemCard, VideoCard, VideoTile } from '../ui/ItemCard';
import { SwipeRow, type SwipeAction } from '../ui/SwipeRow';
import { useTabBarInset } from '../ui/nav/FloatingTabBar';
import { Segmented } from '../ui/media';
import { SearchResults } from '../ui/SearchResults';
import { VoiceSheet } from '../ui/VoiceSheet';
import { radius, space, type, useTheme } from '../ui/theme';
import { IconTile, TINT_CYCLE } from '../ui/tiles';
import { soft, type TintName } from '../ui/tokens';
import { useSettings, useAiInfo } from '../ui/useSettings';

type Props = CompositeScreenProps<BottomTabScreenProps<TabParamList, 'Library'>, NativeStackScreenProps<RootStackParamList>>;
const PAGE = 30;
/** How long Undo is offered after a quick archive or delete (generous for TalkBack users). */
const UNDO_MS = 8000;
type Section = 'videos' | 'websites' | 'notes';
type Shelf = 'favorites' | 'unread' | 'viewed';
const SHELVES: { key: Shelf; label: string; icon: IconName; tint: TintName }[] = [
  { key: 'favorites', label: 'Favourites', icon: 'star', tint: 'yellow' },
  { key: 'unread', label: 'Unread', icon: 'mail-unread', tint: 'blue' },
  { key: 'viewed', label: 'Recently viewed', icon: 'eye', tint: 'purple' },
];
const SECTION_SOURCES: Record<Section, SourceType[]> = { videos: VIDEO_SOURCES, websites: WEBSITE_SOURCES, notes: NOTE_SOURCES };
const SORTS: [SortKey, string][] = [['newest', 'Newest'], ['oldest', 'Oldest'], ['updated', 'Recently updated'], ['title', 'Title A–Z']];
const DATES: [string, string][] = [['any', 'Any time'], ['today', 'Today'], ['week', 'Last 7 days'], ['last30', 'Last 30 days']];

export default function LibraryScreen({ navigation, route }: Props) {
  const { c } = useTheme();
  const settings = useSettings();
  const ai = useAiInfo();
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
  const [section, setSection] = useState<Section>('videos');
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [end, setEnd] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [collectOpen, setCollectOpen] = useState(false);
  const { busy, run } = useAction();
  const inset = useTabBarInset();
  // Single-item quick actions (swipe / TalkBack): deletes wait UNDO_MS so they can be undone.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [snack, setSnack] = useState<{ message: string; undo?: () => void } | null>(null);
  const [collectFor, setCollectFor] = useState<string[] | null>(null);
  const snackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDeletes = useRef<Set<string>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 250);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => setCollectionId(route.params?.collectionId), [route.params?.collectionId]);
  useEffect(() => { if (route.params?.q) setText(route.params.q); }, [route.params?.q]);
  const [voice, setVoice] = useState(false);
  const searching = debounced.trim().length > 0;

  const filter: LibraryFilter = useMemo(() => {
    const allowed = SECTION_SOURCES[section];
    const chosen = sources.filter((s) => allowed.includes(s));
    const f: LibraryFilter = { text: debounced, sourceTypes: chosen.length ? chosen : allowed, statuses, languages, tags, collectionId, archived,
      favorite: shelf === 'favorites' || undefined, unread: shelf === 'unread' || undefined, viewed: shelf === 'viewed' || undefined };
    if (date !== 'any') {
      const r = rangeFor(date as 'today' | 'week' | 'last30', Date.now(), tz);
      f.fromIso = r.startIso;
      f.toIso = r.endIso;
    }
    return f;
  }, [debounced, sources, statuses, languages, tags, collectionId, archived, date, tz, section, shelf]);

  const load = useCallback(async (reset: boolean) => {
    try {
      setLoading(true);
      const repo = await getRepo();
      const offset = reset ? 0 : items.length;
      const page = await repo.listItems(filter, shelf === 'viewed' ? 'viewed' : sort, PAGE, offset);
      setItems((prev) => (reset ? page : [...prev, ...page.filter((p) => !prev.some((x) => x.id === p.id))]));
      setEnd(page.length < PAGE);
      if (reset) setTotal(await repo.countItems(filter));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter, sort, shelf, items.length]);

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, sort]);
  useEffect(() => subscribe((t) => {
    if (t === 'items' || t === 'collections') void load(true);
  }), [load]);

  const facets = useQuery(async (repo) => ({
    tags: (await repo.allTags()).slice(0, 30),
    languages: await repo.itemLanguages(),
    collections: await repo.listCollections(),
    shelves: await repo.shelfCounts(),
    counts: {
      videos: await repo.countItems({ sourceTypes: VIDEO_SOURCES, archived, collectionId }),
      websites: await repo.countItems({ sourceTypes: WEBSITE_SOURCES, archived, collectionId }),
      notes: await repo.countItems({ sourceTypes: NOTE_SOURCES, archived, collectionId }),
    },
  }), ['items', 'collections'], [archived, collectionId]);

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
      const target = collectFor ?? ids;
      await repo.addToCollection(colId, target);
      if (collectFor) {
        const name = facets.data?.collections.find((x) => x.id === colId)?.name ?? 'collection';
        showSnack(`Added to ${name}`);
      } else setSelected(new Set());
      setCollectOpen(false);
      setCollectFor(null);
      emit('items', 'collections');
    }),
  };

  const collectionName = facets.data?.collections.find((x) => x.id === collectionId)?.name;

  const commitDeletes = useCallback(async () => {
    const del = [...pendingDeletes.current];
    if (!del.length) return;
    pendingDeletes.current.clear();
    const repo = await getRepo();
    await deleteItemFiles(del);
    await repo.deleteItems(del);
    setHidden((h) => { const n = new Set(h); for (const d of del) n.delete(d); return n; });
    emit('items');
  }, []);
  // Leaving the screen finishes any delete that is still waiting for Undo.
  useEffect(() => () => {
    if (snackTimer.current) clearTimeout(snackTimer.current);
    void commitDeletes();
  }, [commitDeletes]);

  function showSnack(message: string, undo?: () => void) {
    if (snackTimer.current) clearTimeout(snackTimer.current);
    setSnack({ message, undo });
    snackTimer.current = setTimeout(() => {
      setSnack(null);
      void commitDeletes();
    }, UNDO_MS);
  }

  const quick = {
    archive: (item: Item) => void run(async () => {
      const repo = await getRepo();
      const to = !item.archived;
      await repo.setArchived([item.id], to);
      emit('items');
      showSnack(to ? 'Archived' : 'Restored to library', () => void (async () => {
        await (await getRepo()).setArchived([item.id], !to);
        emit('items');
        setSnack(null);
      })());
    }),
    remove: (item: Item) => {
      pendingDeletes.current.add(item.id);
      setHidden((h) => new Set(h).add(item.id));
      showSnack('Deleted', () => {
        pendingDeletes.current.delete(item.id);
        setHidden((h) => { const n = new Set(h); n.delete(item.id); return n; });
        setSnack(null);
      });
    },
    collect: (item: Item) => { setCollectFor([item.id]); setCollectOpen(true); },
    favorite: (item: Item) => void run(async () => {
      await (await getRepo()).setFavorite([item.id], !item.favorite);
      emit('items');
    }),
  };
  const actionsFor = (item: Item): SwipeAction[] => [
    { name: 'archive', label: item.archived ? 'Restore' : 'Archive', icon: item.archived ? 'arrow-undo-outline' : 'archive-outline', tone: 'accent', run: () => quick.archive(item) },
    { name: 'favorite', label: item.favorite ? 'Unstar' : 'Favourite', icon: item.favorite ? 'star' : 'star-outline', tone: 'accent', run: () => quick.favorite(item) },
    { name: 'collect', label: 'Collection', icon: 'folder-outline', tone: 'info', run: () => quick.collect(item) },
    { name: 'delete', label: 'Delete', icon: 'trash-outline', tone: 'danger', run: () => quick.remove(item) },
  ];
  const visible = hidden.size ? items.filter((i) => !hidden.has(i.id)) : items;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <Backdrop />
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: space.sm, minHeight: 56 }}>
        {selecting ? (
          <>
            <IconButton icon="close" label="Clear selection" onPress={() => setSelected(new Set())} />
            <T v="title" style={{ flex: 1 }}>{selected.size} selected</T>
            <IconButton icon="document-text-outline" label="Report on selected items" onPress={() => void run(async () => {
              const r = await generateReport({ kind: 'selection', itemIds: ids, useAi: ai?.enabled });
              setSelected(new Set());
              navigation.navigate('ReportDetail', { id: r.id });
            }, 'Report failed')} />
            <IconButton icon="star-outline" label="Add to favourites" onPress={() => void run(async () => { await (await getRepo()).setFavorite(ids, true); setSelected(new Set()); emit('items'); })} />
            <IconButton icon="folder-outline" label="Add to collection" onPress={() => setCollectOpen(true)} />
            <IconButton icon={archived ? 'arrow-undo-outline' : 'archive-outline'} label={archived ? 'Restore' : 'Archive'} onPress={() => void bulk.archive()} />
            <IconButton icon="trash-outline" label="Delete" color={c.danger} onPress={() => void bulk.delete()} />
          </>
        ) : (
          <>
            <T v="display" style={{ flex: 1 }} accessibilityRole="header">{archived ? 'Archive' : collectionName ?? 'Library'}</T>
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <CircleButton icon={grid ? 'list-outline' : 'grid-outline'} label={grid ? 'List view' : 'Grid view'} onPress={() => void updateSettings({ libraryView: grid ? 'list' : 'grid' })} />
              <CircleButton icon="ellipsis-horizontal" label="More" onPress={() => setMenuOpen(true)} />
            </View>
          </>
        )}
      </View>
      <View style={{ paddingHorizontal: space.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: c.surface, borderRadius: radius.pill, borderWidth: 1, borderColor: c.border, paddingLeft: space.md }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Search titles, transcripts, notes…"
            placeholderTextColor={c.textFaint}
            accessibilityLabel="Search your library"
            style={[type.body, { flex: 1, color: c.text, minHeight: 48 }]}
            returnKeyType="search"
          />
          {text ? <IconButton icon="close-circle" label="Clear search" onPress={() => setText('')} color={c.textMuted} /> : <IconButton icon="mic-outline" label="Search by voice" onPress={() => setVoice(true)} />}
          <IconButton icon="options-outline" label={`Filters${activeFilters ? `, ${activeFilters} active` : ''}`} onPress={() => setFiltersOpen(true)} />
        </View>
        {searching || archived ? null : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: space.md, marginHorizontal: -space.lg }} contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm }}>
            {SHELVES.map((sh) => (
              <ShelfCard key={sh.key} icon={sh.icon} tint={sh.tint} label={sh.label} count={facets.data?.shelves[sh.key]} selected={shelf === sh.key}
                onPress={() => { setShelf(shelf === sh.key ? null : sh.key); setSelected(new Set()); }} />
            ))}
            <ShelfCard icon="bookmark" tint="orange" label="Highlights" count={facets.data?.shelves.highlights} onPress={() => navigation.navigate('Highlights')} />
            {(facets.data?.collections ?? []).map((col, i) => (
              <ShelfCard key={col.id} icon={col.rules ? 'sparkles' : 'albums'} tint={TINT_CYCLE[(i + 3) % TINT_CYCLE.length]} label={col.name} count={col.itemCount} selected={collectionId === col.id}
                onPress={() => setCollectionId(collectionId === col.id ? undefined : col.id)} />
            ))}
            <ShelfCard icon="add" tint="gray" label="New collection" onPress={() => navigation.navigate('Collections')} />
          </ScrollView>
        )}
        {searching ? null : <View style={{ marginTop: space.md }}>
          <Segmented<Section>
            value={section}
            onChange={(k) => { setSection(k); setSelected(new Set()); }}
            options={[
              { key: 'videos', label: 'Videos', count: facets.data?.counts.videos },
              { key: 'websites', label: 'Websites', count: facets.data?.counts.websites },
              { key: 'notes', label: 'Notes', count: facets.data?.counts.notes },
            ]}
          />
        </View>}
        {searching ? null : <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: space.sm, flexWrap: 'wrap' }}>
          <T v="caption" color="textMuted" style={{ marginRight: space.sm }}>{total} item{total === 1 ? '' : 's'}</T>
          {shelf ? <Chip label={SHELVES.find((x) => x.key === shelf)!.label} selected onPress={() => setShelf(null)} /> : null}
          {collectionName ? <Chip label={collectionName} selected onPress={() => setCollectionId(undefined)} /> : null}
          {activeFilters ? <Chip label={`${activeFilters} filter(s)`} tone="accent" onPress={() => setFiltersOpen(true)} /> : null}
        </View>}
      </View>
      {error ? <View style={{ paddingHorizontal: space.lg }}><Banner tone="danger" title="Couldn't load library" body={error} action={<Button kind="outline" title="Retry" onPress={() => void load(true)} />} /></View> : null}
      {searching ? <SearchResults query={debounced} bottomInset={inset} onOpen={(id) => navigation.navigate('ItemDetail', { id })} /> : <FlatList
        key={grid ? 'grid' : 'list'}
        data={visible}
        numColumns={grid ? 2 : 1}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: grid ? space.lg - space.xs : space.lg, paddingBottom: inset + space.lg }}
        renderItem={({ item }) => {
          const onPress = () => (selecting ? setSelected((s) => { const n = new Set(s); n.has(item.id) ? n.delete(item.id) : n.add(item.id); return n; }) : navigation.navigate('ItemDetail', { id: item.id }));
          const onLongPress = () => setSelected((s) => new Set(s).add(item.id));
          const acts = actionsFor(item);
          const props = { item, selected: selected.has(item.id), onPress, onLongPress, actions: selecting ? undefined : acts };
          if (grid) return section === 'videos' ? <VideoTile {...props} /> : <ItemCard {...props} grid timezone={tz} />;
          return (
            <SwipeRow enabled={!selecting} left={acts[0]} right={acts.slice(1)}>
              {section === 'videos' ? <VideoCard {...props} timezone={tz} /> : <ItemCard {...props} timezone={tz} />}
            </SwipeRow>
          );
        }}
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
            <EmptyState
              icon={section === 'videos' ? 'play-circle-outline' : section === 'websites' ? 'globe-outline' : 'document-text-outline'}
              title={section === 'videos' ? 'No videos yet' : section === 'websites' ? 'No websites yet' : 'No notes yet'}
              body={section === 'videos' ? 'Share a YouTube, Instagram or X video to Qivra — it is transcribed and summarised automatically.' : section === 'websites' ? 'Share any article or GitHub link; Qivra extracts the text and summarises it.' : 'Write a note, paste text, or import a transcript file.'}
              action={<Button title={section === 'notes' ? 'New note' : 'Save a link'} icon="add" onPress={() => navigation.navigate('Capture', { mode: section === 'notes' ? 'note' : 'link' })} />}
            />
          )
        ) : null}
      />}
      <VoiceSheet visible={voice} onClose={() => setVoice(false)} purpose="dictate" onText={(t) => setText(t.replace(/[.?!]+$/, ''))} onOpenSettings={() => navigation.navigate('VoiceSettings')} />

      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)} title="Library">
        <Row icon={archived ? 'albums' : 'archive'} tint={c.tint.gray} title={archived ? 'Show library' : 'Show archive'} onPress={() => { setArchived(!archived); setShelf(null); setMenuOpen(false); }} />
        <Row icon="bookmark" tint={c.tint.orange} title="Highlights" value={String(facets.data?.shelves.highlights ?? '')} onPress={() => { setMenuOpen(false); navigation.navigate('Highlights'); }} />
        <Row icon="albums" tint={c.tint.blue} title="Collections" onPress={() => { setMenuOpen(false); navigation.navigate('Collections'); }} />
        <Row icon="settings" tint={c.tint.gray} title="Settings" onPress={() => { setMenuOpen(false); navigation.navigate('Settings'); }} />
      </Sheet>
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

      <Sheet visible={collectOpen} onClose={() => { setCollectOpen(false); setCollectFor(null); }} title={collectFor ? 'Add this item to a collection' : 'Add to collection'}>
        {/* Smart collections fill themselves from their rules, so items can't be added by hand. */}
        {facets.data?.collections.some((col) => !col.rules) ? facets.data.collections.filter((col) => !col.rules).map((col) => (
          <Button key={col.id} kind="outline" title={`${col.name} (${col.itemCount})`} onPress={() => void bulk.collect(col.id)} style={{ marginBottom: space.sm }} />
        )) : <T color="textMuted">No collections yet. Create one from Collections.</T>}
        <Button kind="text" title="Manage collections" onPress={() => { setCollectOpen(false); navigation.navigate('Collections'); }} />
      </Sheet>
      {busy ? <View style={{ position: 'absolute', top: 0, left: 0, right: 0 }}><Loading label="Working" /></View> : null}
      <Snackbar bottom={inset} message={snack?.message ?? null} actionLabel={snack?.undo ? 'Undo' : undefined} onAction={snack?.undo} />
    </SafeAreaView>
  );
}

/** A shelf at the top of the Library: coloured icon, name and count. Selected shelves are outlined. */
function ShelfCard({ icon, tint, label, count, selected, onPress }: { icon: IconName; tint: TintName; label: string; count?: number; selected?: boolean; onPress: () => void }) {
  const { c } = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={count !== undefined ? `${label}, ${count}` : label} accessibilityState={{ selected: !!selected }}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.sm, height: 52, paddingLeft: 8, paddingRight: space.md, borderRadius: radius.lg,
        backgroundColor: selected ? soft(c.tint[tint]) : c.surface, borderWidth: 1.5, borderColor: selected ? c.tint[tint] : c.border, opacity: pressed ? 0.7 : 1 })}>
      <IconTile icon={icon} tint={tint} size={34} />
      <View>
        <T v="caption" style={{ fontWeight: '700' }} numberOfLines={1}>{label}</T>
        {count !== undefined ? <T v="caption" color="textMuted">{count}</T> : null}
      </View>
    </Pressable>
  );
}
