/**
 * End-to-end: TypeScript API client + sync engine ⇄ real Python Qivra server.
 * Skipped automatically when server/.venv is missing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openNodeDriver } from '../helpers/nodeDriver';
import { migrate } from '../../src/db/schema';
import { Repo } from '../../src/db/repo';
import { QivraClient } from '../../src/core/api';
import { enableSync, resolveConflict, runSync } from '../../src/sync/engine';
import { parsePairingQr } from '../../src/core/qr';

const SERVER_DIR = resolve(__dirname, '../../server');
const PY = join(SERVER_DIR, '.venv/bin/python');
const maybe = existsSync(PY) ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function startServer(port: number, dataDir: string): Promise<{ proc: ChildProcess; output: () => string }> {
  let out = '';
  const proc = spawn(PY, ['-m', 'qivra', 'serve', '--no-legacy', '--no-qr', '--port', String(port)], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_PATH: join(dataDir, 'server.db'), QIVRA_DATA_DIR: join(dataDir, 'data'), NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => {
    out += d.toString();
  });
  proc.stderr!.on('data', (d) => {
    out += d.toString();
  });
  const deadline = Date.now() + 20_000;
  while (!/Access ID/.test(out)) {
    if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`server did not start:\n${out}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { proc, output: () => out };
}

async function ownerChallenge(base: string): Promise<{ pairing_id: string; server_id: string; qr_payload: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/v1/pairing/challenges`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`challenge failed ${r.status}`);
  return r.json() as never;
}

async function device(base: string, name: string): Promise<{ repo: Repo; client: QivraClient; deviceId: string; token: string }> {
  const ch = await ownerChallenge(base);
  // Exercise the same QR validation the app performs on scan.
  const parsed = parsePairingQr(JSON.stringify(ch.qr_payload), Date.now());
  if (!parsed.ok) throw new Error(`QR rejected: ${parsed.error}`);
  const anon = new QivraClient({ baseUrl: parsed.payload.serverUrl });
  const health = await anon.health();
  expect(health.server_id).toBe(parsed.payload.serverId);
  const res = await anon.completePairing(parsed.payload.pairingId, name, parsed.payload.serverId);
  const db = openNodeDriver();
  await migrate(db);
  const repo = new Repo(db);
  return { repo, client: new QivraClient({ baseUrl: base, token: res.device_token }), deviceId: res.device.id, token: res.device_token };
}

maybe('sync with the real local server', () => {
  let srv: { proc: ChildProcess; output: () => string };
  let port: number;
  let dir: string;
  let base: string;

  beforeAll(async () => {
    port = await freePort();
    dir = mkdtempSync(join(tmpdir(), 'qivra-int-'));
    srv = await startServer(port, dir);
    base = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(() => {
    srv?.proc.kill('SIGTERM');
  });

  test('startup output reports the real port and passes its own health check', () => {
    const out = srv.output();
    expect(out).toContain(`http://127.0.0.1:${port}`);
    expect(out).toContain('health check passed');
    expect(out).toContain('Public exposure: disabled');
    expect(out).not.toMatch(/qv1_/); // no credentials printed
  });

  test('two devices: push, pull, conflict, keep-both, delete, revoke, restart', async () => {
    const A = await device(base, 'Phone A');
    const B = await device(base, 'Phone B');

    // A captures and syncs.
    await enableSync(A.repo);
    const { item } = await A.repo.createItem({ sourceType: 'note', title: 'Claude Code hooks', note: 'v1', tags: ['claude-code'] });
    const col = await A.repo.createCollection('Agents');
    await A.repo.addToCollection(col.id, [item.id]);
    const s1 = await runSync(A.repo, A.client);
    expect(s1).toMatchObject({ applied: 2, conflicts: 0 });
    expect((await A.repo.getItem(item.id))?.syncStatus).toBe('synced');

    // B pulls it.
    await enableSync(B.repo);
    const s2 = await runSync(B.repo, B.client);
    expect(s2.pulled).toBe(2);
    const onB = await B.repo.getItem(item.id);
    expect(onB).toMatchObject({ title: 'Claude Code hooks', note: 'v1', syncStatus: 'synced', tags: ['claude-code'] });
    expect((await B.repo.listItems({ collectionId: col.id })).map((i) => i.id)).toEqual([item.id]);

    // Concurrent edits.
    await A.repo.updateItem(item.id, { note: 'edited on A' });
    await B.repo.updateItem(item.id, { note: 'edited on B' });
    await runSync(A.repo, A.client);
    const s3 = await runSync(B.repo, B.client);
    expect(s3.conflicts).toBe(1);
    expect((await B.repo.getItem(item.id))).toMatchObject({ note: 'edited on B', syncStatus: 'conflicted' }); // not overwritten
    const [conflict] = await B.repo.openConflicts();
    expect(conflict.remote.note).toBe('edited on A');

    // B keeps both versions.
    await resolveConflict(B.repo, conflict.id, 'keep_both');
    expect(await B.repo.getItem(item.id)).toMatchObject({ note: 'edited on A', syncStatus: 'synced' });
    const copies = (await B.repo.listItems({ text: 'my version' }));
    expect(copies).toHaveLength(1);
    expect(copies[0].note).toBe('edited on B');
    await runSync(B.repo, B.client);
    await runSync(A.repo, A.client);
    expect((await A.repo.listItems({ text: 'my version' })).map((i) => i.note)).toEqual(['edited on B']);

    // Keep-local resolution path.
    await A.repo.updateItem(item.id, { title: 'A title' });
    await B.repo.updateItem(item.id, { title: 'B title' });
    await runSync(A.repo, A.client);
    await runSync(B.repo, B.client);
    const [c2] = await B.repo.openConflicts();
    await resolveConflict(B.repo, c2.id, 'keep_local');
    await runSync(B.repo, B.client);
    await runSync(A.repo, A.client);
    expect((await A.repo.getItem(item.id))?.title).toBe('B title');

    // Delete propagates as a tombstone.
    await A.repo.deleteItems([item.id]);
    await runSync(A.repo, A.client);
    expect(await A.repo.getItem(item.id)).toBeNull();
    const s4 = await runSync(B.repo, B.client);
    expect(s4.purged).toBe(1);
    expect(await B.repo.getItem(item.id)).toBeNull();

    // Revocation from the laptop.
    const rev = await fetch(`${base}/api/v1/devices/${B.deviceId}/revoke`, { method: 'POST' });
    expect(rev.status).toBe(200);
    await expect(runSync(B.repo, B.client)).rejects.toMatchObject({ kind: 'revoked' });

    // Server restart keeps A's credential and data.
    srv.proc.kill('SIGTERM');
    await new Promise((r) => srv.proc.once('exit', r));
    srv = await startServer(port, dir);
    await expect(A.client.pairingStatus()).resolves.toMatchObject({ paired: true });
    const s5 = await runSync(A.repo, A.client);
    expect(s5.conflicts).toBe(0);
  }, 60_000);

  test('pairing failures map to clear client errors', async () => {
    const anon = new QivraClient({ baseUrl: base });
    await expect(anon.completePairing('ZZZZZZZZ', 'x', null)).rejects.toMatchObject({ kind: 'pairing' });
    const ch = await ownerChallenge(base);
    await expect(anon.completePairing(ch.pairing_id, 'x', 'ffffffffffffffff')).rejects.toMatchObject({ kind: 'wrong_server' });
    await anon.completePairing(ch.pairing_id, 'x', ch.server_id);
    await expect(anon.completePairing(ch.pairing_id, 'x', ch.server_id)).rejects.toMatchObject({ kind: 'pairing', code: 'PAIRING_ALREADY_USED' });
    await expect(new QivraClient({ baseUrl: base, token: 'qv1_nope' }).pairingStatus()).rejects.toMatchObject({ kind: 'revoked' });
    // Wrong port → offline.
    await expect(new QivraClient({ baseUrl: `http://127.0.0.1:${port + 1}`, retries: 0 }).health(1000)).rejects.toMatchObject({ kind: 'offline' });
  });
});
