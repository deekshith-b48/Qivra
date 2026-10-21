import React from 'react';
import { View } from 'react-native';
import type { RootProps } from '../navigation/types';
import { getRepo } from '../services/db';
import { Button, Card, Screen, T, Wordmark } from '../ui/components';
import { space } from '../ui/theme';

const POINTS: [string, string][] = [
  ['Save from anywhere', 'Share links, text and transcript files from any app, or add them here. Everything is stored on this phone first.'],
  ['Searchable knowledge', 'Transcripts, notes and summaries are indexed on-device, so search works offline.'],
  ['Grounded answers', 'Ask about what you saved. Answers cite your items — Qivra says so when it has no evidence.'],
  ['Your own server, optional', 'Pair with the Qivra server on your laptop for sync and heavier processing. No cloud account required.'],
];

export default function OnboardingScreen({ navigation }: RootProps<'Onboarding'>) {
  const finish = async (next: 'Main' | 'ConnectServer') => {
    const repo = await getRepo();
    await repo.setMeta('app.onboarded', '1');
    navigation.reset({ index: next === 'Main' ? 0 : 1, routes: next === 'Main' ? [{ name: 'Main' }] : [{ name: 'Main' }, { name: 'ConnectServer' }] });
  };
  return (
    <Screen edges={['top', 'bottom']}>
      <View style={{ paddingTop: space.xxl, paddingBottom: space.xl }}>
        <Wordmark size={30} />
        <T v="display" style={{ marginTop: space.xl }}>Turn what you save into what you know.</T>
        <T color="textMuted" style={{ marginTop: space.sm }}>A private, local-first knowledge vault for Android.</T>
      </View>
      {POINTS.map(([title, body]) => (
        <Card key={title} style={{ marginBottom: space.sm }}>
          <T v="subtitle">{title}</T>
          <T v="small" color="textMuted" style={{ marginTop: 2 }}>{body}</T>
        </Card>
      ))}
      <View style={{ marginTop: space.xl, gap: space.sm }}>
        <Button title="Start using Qivra" onPress={() => void finish('Main')} />
        <Button title="Connect to my server first" kind="outline" icon="qr-code-outline" onPress={() => void finish('ConnectServer')} />
      </View>
    </Screen>
  );
}
