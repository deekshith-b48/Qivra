import React from 'react';
import { View } from 'react-native';
import { formatLocal } from '../core/dates';
import type { RootProps } from '../navigation/types';
import { getRepo } from '../services/db';
import { emit } from '../services/events';
import { runDueJobs } from '../services/processing';
import { Button, Card, Chip, EmptyState, Header, IconButton, Screen, T } from '../ui/components';
import { useAction, useQuery } from '../ui/hooks';
import { space } from '../ui/theme';
import { useSettings } from '../ui/useSettings';

export default function JobsScreen({ navigation }: RootProps<'Jobs'>) {
  const tz = useSettings()?.timezone ?? 'UTC';
  const { busy, run } = useAction();
  const q = useQuery(async (repo) => {
    const jobs = await repo.listJobs({ limit: 100 });
    const titles = Object.fromEntries((await repo.itemsByIds([...new Set(jobs.map((j) => j.itemId).filter((x): x is string => !!x))])).map((i) => [i.id, i.title || i.url || 'Untitled']));
    return { jobs, titles, counts: await repo.jobCounts() };
  }, ['jobs', 'items']);
  const d = q.data;

  return (
    <Screen>
      <Header title="Processing queue" subtitle="Durable: survives restarts. Retries back off automatically." onBack={() => navigation.goBack()} actions={<IconButton icon="play-outline" label="Run now" onPress={() => void run(() => runDueJobs())} />} />
      {d ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: space.md }}>
          <Chip label={`${d.counts.queued} queued`} />
          <Chip label={`${d.counts.running} running`} tone="info" />
          <Chip label={`${d.counts.failed_retryable} retrying`} tone="warning" />
          <Chip label={`${d.counts.failed_permanent} failed`} tone="danger" />
          <Chip label={`${d.counts.succeeded} done`} tone="accent" />
        </View>
      ) : null}
      {d?.jobs.length ? d.jobs.map((j) => (
        <Card key={j.id} onPress={j.itemId ? () => navigation.navigate('ItemDetail', { id: j.itemId! }) : undefined} label={`${j.kind} ${j.status}`} style={{ marginBottom: space.sm }}>
          <T v="subtitle">{j.kind.replace(/_/g, ' ')}{j.itemId ? ` · ${d.titles[j.itemId] ?? 'deleted item'}` : ''}</T>
          <T v="small" color={j.status === 'failed_permanent' ? 'danger' : 'textMuted'}>{j.status.replace(/_/g, ' ')} · attempt {j.attempts}/{j.maxAttempts} · updated {formatLocal(j.updatedAt, tz)}</T>
          {j.status === 'failed_retryable' ? <T v="caption" color="textFaint">Next try after {formatLocal(j.runAfter, tz)}</T> : null}
          {j.lastError ? <T v="small" color="textMuted">{j.lastErrorCode}: {j.lastError}</T> : null}
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            {['failed_permanent', 'failed_retryable', 'cancelled'].includes(j.status) ? <Button kind="text" title="Retry" onPress={() => void run(async () => { const repo = await getRepo(); await repo.enqueueJob({ id: j.id, kind: j.kind, itemId: j.itemId, retry: true }); emit('jobs'); await runDueJobs(); })} /> : null}
            {['queued', 'failed_retryable'].includes(j.status) ? <Button kind="text" title="Cancel" onPress={() => void run(async () => { await (await getRepo()).cancelJob(j.id); emit('jobs'); })} /> : null}
          </View>
        </Card>
      )) : <EmptyState icon="checkmark-done-outline" title="Nothing in the queue" />}
      {busy ? <T v="small" color="textMuted">Running…</T> : null}
    </Screen>
  );
}
