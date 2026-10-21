import React from 'react';
import { STATUS_LABELS, type ItemStatus } from '../core/status';
import type { RootProps } from '../navigation/types';
import { Banner, Button, Header, Screen } from '../ui/components';
import { useQuery } from '../ui/hooks';

/** Shown after an Android share: the real, current status of each saved item. */
export default function ShareReceiptScreen({ navigation, route }: RootProps<'ShareReceipt'>) {
  const { results, rejected } = route.params;
  const live = useQuery(async (repo) => Promise.all(results.map(async (r) => (r.itemId ? repo.getItem(r.itemId) : null))), ['items', 'jobs'], [results]);
  return (
    <Screen>
      <Header title={results.length ? 'Saved to Qivra' : 'Nothing saved'} onBack={() => navigation.goBack()} />
      {results.map((r, i) => {
        const item = live.data?.[i];
        const status = item ? STATUS_LABELS[item.status as ItemStatus] : r.status;
        return (
          <Banner
            key={`${r.itemId}-${i}`}
            tone={r.error ? 'danger' : r.duplicate ? 'warning' : 'accent'}
            title={item?.title || r.title}
            body={r.error ? r.error : `${r.duplicate ? 'Already in your library. ' : ''}Status: ${status}`}
            action={r.itemId ? <Button kind="outline" title="Open" onPress={() => navigation.replace('ItemDetail', { id: r.itemId! })} /> : undefined}
          />
        );
      })}
      {rejected.map((x, i) => <Banner key={`rej-${i}`} tone="danger" title={`Not saved: ${x.name}`} body={x.reason} />)}
      <Button title="Done" onPress={() => navigation.goBack()} />
    </Screen>
  );
}
