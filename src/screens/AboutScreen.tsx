import Constants from 'expo-constants';
import React from 'react';
import { Linking } from 'react-native';
import type { RootProps } from '../navigation/types';
import { Card, Header, Screen, Section, T, Wordmark } from '../ui/components';
import { space } from '../ui/theme';

export default function AboutScreen({ navigation }: RootProps<'About'>) {
  return (
    <Screen>
      <Header title="About" onBack={() => navigation.goBack()} />
      <Card>
        <Wordmark size={26} />
        <T color="textMuted" style={{ marginTop: space.sm }}>Version {Constants.expoConfig?.version ?? '—'}</T>
        <T v="small" color="textMuted">A private, local-first knowledge vault for Android.</T>
      </Card>
      <Section title="Based on SuperBrain">
        <T v="small" color="textMuted">Qivra is a derivative of SuperBrain by sidinsearch, licensed under the GNU Affero General Public License v3.0. Qivra is distributed under the same license; the complete source is available to every user, including users of the local server over a network (AGPL §13).</T>
        <T v="small" color="accent" style={{ textDecorationLine: 'underline', marginTop: 4 }} onPress={() => void Linking.openURL('https://github.com/sidinsearch/superbrain')}>github.com/sidinsearch/superbrain</T>
        <T v="small" color="accent" style={{ textDecorationLine: 'underline', marginTop: 4 }} onPress={() => void Linking.openURL('https://www.gnu.org/licenses/agpl-3.0.html')}>GNU AGPL v3.0</T>
      </Section>
      <Section title="Third-party software">
        <T v="small" color="textMuted">React Native, Expo SDK modules, React Navigation, SQLite (public domain), Ionicons (MIT). Server: FastAPI, Uvicorn, Pydantic (MIT/BSD), segno (BSD). See docs/SUPERBRAIN_TO_QIVRA_MIGRATION.md for the dependency inventory.</T>
      </Section>
    </Screen>
  );
}
