import { openNodeDriver } from '../helpers/nodeDriver';
import { LATEST_VERSION, MIGRATIONS, migrate } from '../../src/db/schema';
import { Repo } from '../../src/db/repo';
import { rulesToFilter, sanitizeRules } from '../../src/core/smart';
import type { Enrichment } from '../../src/core/enrich';

const NOW = new Date('2026-10-22T12:00:00Z');

async function freshRepo() {
  const db = openNodeDriver();
  await migrate(db);
  return new Repo(db, () => NOW);
}

const enr = (concepts: string[], extra: Partial<Enrichment> = {}): Enrichment => ({
  origin: 'local', version: 1, provider: 'test', generatedAt: NOW.toISOString(), summary: '', keyPoints: [], concepts, tools: [], commands: [],
  repos: [], urls: [], tags: [], followUpQuestions: [], actionItems: [], timestamps: [], ...extra,
});

describe('migration v2', () => {
  test('v1 → v2 keeps collections and adds rules_json and cards', async () => {
    const db = openNodeDriver();
    await db.exec(MIGRATIONS[0].sql);
    await db.exec('PRAGMA user_version = 1');
    await db.run("INSERT INTO collections (id, name, created_at, updated_at) VALUES ('col_1', 'Old', 'x', 'x')");
    expect(await migrate(db)).toEqual({ from: 1, to: LATEST_VERSION });
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(2);
    expect(await db.get('SELECT name, rules_json FROM collections')).toEqual({ name: 'Old', rules_json: null });
    const cols = await db.all<{ name: string }>('PRAGMA table_info(cards)');
    expect(cols.map((c) => c.name)).toEqual(['id', 'item_id', 'front', 'back', 'start_ms', 'due_at', 'interval_days', 'ease', 'reps', 'lapses', 'created_at', 'origin']);
    const idx = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cards'");
    expect(idx.map((i) => i.name)).toContain('idx_cards_due');
  });
});

describe('smart rules', () => {
  test('rules convert to a library filter', () => {
    expect(rulesToFilter({ sourceTypes: ['youtube'], tags: ['RAG'], concepts: ['Vector Search'], text: ' hooks ', statuses: ['READY'], savedWithinDays: 7, unread: true }, NOW)).toEqual({
      sourceTypes: ['youtube'], tags: ['rag'], concepts: ['vector search'], text: 'hooks', statuses: ['READY'], fromIso: '2026-10-15T12:00:00.000Z', unread: true,
    });
    expect(rulesToFilter({}, NOW)).toEqual({});
  });

  test('stored rules are parsed defensively', () => {
    expect(sanitizeRules('not json')).toBeNull();
    expect(sanitizeRules({ evil: 1, tags: ['A', 'a', 3], savedWithinDays: -2, unread: 'yes' })).toEqual({ tags: ['a'] });
    expect(sanitizeRules({})).toBeNull();
    expect(sanitizeRules('{"concepts":["RAG"],"unread":true}')).toEqual({ concepts: ['rag'], unread: true });
  });

  test('listItems/countItems resolve a smart collection from its rules', async () => {
    const repo = await freshRepo();
    const a = (await repo.createItem({ sourceType: 'youtube', title: 'A' })).item;
    const b = (await repo.createItem({ sourceType: 'web', title: 'B' })).item;
    const c = (await repo.createItem({ sourceType: 'youtube', title: 'C' })).item;
    await repo.updateItem(a.id, { enrichment: enr(['Vector Search', 'RAG']) });
    await repo.updateItem(b.id, { enrichment: enr(['vector search']) });
    await repo.updateItem(c.id, { enrichment: enr(['Hooks']) });
    await repo.markViewed(c.id);
    // Corrupt JSON must not break the query.
    await repo.db.run("UPDATE items SET enrichment_json = '{oops' WHERE id = ?", [c.id]);

    expect((await repo.listItems({ concepts: ['VECTOR SEARCH'] })).map((i) => i.title).sort()).toEqual(['A', 'B']);
    expect((await repo.listItems({ unread: true })).map((i) => i.title).sort()).toEqual(['A', 'B']);

    const smart = await repo.createSmartCollection('Vectors on YouTube', { concepts: ['vector search'], sourceTypes: ['youtube'] });
    expect(smart.rules).toEqual({ sourceTypes: ['youtube'], concepts: ['vector search'] });
    expect(smart.itemCount).toBe(1);
    expect((await repo.listItems({ collectionId: smart.id })).map((i) => i.title)).toEqual(['A']);
    expect(await repo.countItems({ collectionId: smart.id })).toBe(1);
    // Other filters still apply on top of the rules.
    expect(await repo.countItems({ collectionId: smart.id, sourceTypes: ['web'] })).toBe(0);
    expect((await repo.listCollections())[0]).toMatchObject({ name: 'Vectors on YouTube', itemCount: 1 });

    const recent = await repo.createSmartCollection('Recent text', { text: 'B', savedWithinDays: 30 });
    expect((await repo.listItems({ collectionId: recent.id })).map((i) => i.title)).toEqual(['B']);
    expect(await repo.countItems({ collectionId: recent.id })).toBe(1);

    await expect(repo.createSmartCollection('Empty', {})).rejects.toThrow(/at least one rule/);
    // Manual collections are unchanged.
    const manual = await repo.createCollection('Manual');
    await repo.addToCollection(manual.id, [b.id]);
    expect((await repo.listItems({ collectionId: manual.id })).map((i) => i.title)).toEqual(['B']);
    expect((await repo.getCollection(manual.id))?.rules).toBeNull();
  });

  test('suggestions: concepts and tags on ≥3 live items, not already a collection, top 5', async () => {
    const repo = await freshRepo();
    const mk = async (concepts: string[], tags: string[] = []) => {
      const { item } = await repo.createItem({ sourceType: 'note', title: concepts.join(','), tags });
      await repo.updateItem(item.id, { enrichment: enr(concepts) });
      return item;
    };
    await mk(['RAG', 'Embeddings'], ['ai']);
    await mk(['rag', 'Embeddings'], ['ai']);
    await mk(['Rag'], ['ai']);
    const gone = await mk(['Embeddings'], ['ai']);
    await mk(['Hooks']);
    await repo.deleteItems([gone.id]);
    await repo.createCollection('AI');
    const s = await repo.suggestCollections();
    expect(s).toEqual([{ name: 'rag', kind: 'concept', count: 3, rules: { concepts: ['rag'] } }]);
    // Seven more concepts on 3 items each: still at most 5 suggestions.
    for (let i = 0; i < 3; i++) await mk(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    expect(await repo.suggestCollections()).toHaveLength(5);
  });
});

describe('cards in the repo', () => {
  test('no duplicates, due ordering, collection scope, cascade', async () => {
    const repo = await freshRepo();
    const { item } = await repo.createItem({ sourceType: 'note', title: 'N', tags: ['x'] });
    const other = (await repo.createItem({ sourceType: 'web', title: 'W' })).item;
    const added = await repo.addCards(item.id, [
      { front: 'What is RAG?', back: 'retrieval', startMs: 1000, origin: 'model' },
      { front: 'what is rag', back: 'dup', startMs: null, origin: 'model' },
    ]);
    expect(added).toHaveLength(1);
    expect(await repo.addCards(item.id, [{ front: 'What is RAG?!', back: 'r', startMs: null, origin: 'local' }])).toHaveLength(0);
    await repo.addCards(other.id, [{ front: 'Q2', back: 'a', startMs: null, origin: 'local' }]);
    const now = NOW.toISOString();
    expect(await repo.countDueCards(now)).toBe(2);
    const smart = await repo.createSmartCollection('Tagged', { tags: ['x'] });
    expect((await repo.dueCards(now, 10, smart.id)).map((c) => c.front)).toEqual(['What is RAG?']);
    await repo.saveCardSchedule({ ...added[0], dueAt: '2026-11-01T00:00:00Z', reps: 1, intervalDays: 1 });
    expect(await repo.countDueCards(now, smart.id)).toBe(0);
    await repo.db.run('DELETE FROM items WHERE id = ?', [other.id]);
    expect(await repo.countDueCards(now)).toBe(0);
    expect(await repo.listCards(other.id)).toEqual([]);
  });
});
