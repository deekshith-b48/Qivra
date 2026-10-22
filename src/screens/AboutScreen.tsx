import Constants from 'expo-constants';
import React from 'react';
import { Linking } from 'react-native';
import type { RootProps } from '../navigation/types';
import { Card, Group, Header, Row, Screen, Section, T, Wordmark } from '../ui/components';
import { space, useTheme } from '../ui/theme';

const REPO = 'https://github.com/deekshith-b48/Qivra';

export default function AboutScreen({ navigation }: RootProps<'About'>) {
  const { c } = useTheme();
  const [licenses, setLicenses] = React.useState(false);
  return (
    <Screen>
      <Header title="About" onBack={() => navigation.goBack()} />
      <Card>
        <Wordmark size={28} />
        <T color="textMuted" style={{ marginTop: space.sm }}>Version {Constants.expoConfig?.version ?? '—'}</T>
        <T v="small" color="textMuted" style={{ marginTop: 2 }}>Turn what you save into what you know: a private knowledge vault for reels, videos, pages and notes.</T>
      </Card>
      <Section title="More">
        <Group>
          <Row icon="logo-github" tint={c.tint.gray} title="Source code" value="GitHub" onPress={() => void Linking.openURL(REPO)} />
          <Row icon="book" tint={c.tint.blue} title="What's new and how it works" onPress={() => void Linking.openURL(`${REPO}#readme`)} />
          <Row icon="download" tint={c.tint.green} title="Latest version" onPress={() => void Linking.openURL(`${REPO}/releases/latest`)} />
          <Row icon="document-text" tint={c.tint.purple} title="Open-source licenses" value={licenses ? 'Hide' : 'Show'} onPress={() => setLicenses(!licenses)} />
        </Group>
      </Section>
      {licenses ? (
        <Card style={{ marginTop: space.md }}>
          {/* Appropriate Legal Notices (GNU AGPL v3 §5): license, copyright and no-warranty; full notices in NOTICE.md. */}
          <T v="small" color="textMuted">Qivra is free software under the GNU Affero General Public License v3.0; its complete source is available to every user.</T>
          <T v="small" color="accent" style={{ textDecorationLine: 'underline', marginTop: 4 }} onPress={() => void Linking.openURL('https://www.gnu.org/licenses/agpl-3.0.html')}>GNU AGPL v3.0</T>
          <T v="small" color="textMuted" style={{ marginTop: space.sm }}>© Qivra contributors and upstream authors. This program comes with no warranty. Full copyright notices are in the source code (NOTICE.md).</T>
          <T v="small" color="accent" style={{ textDecorationLine: 'underline', marginTop: 4 }} onPress={() => void Linking.openURL(`${REPO}/blob/main/NOTICE.md`)}>View notices</T>
          <T v="small" color="textMuted" style={{ marginTop: space.sm }}>Third-party: React Native, Expo SDK modules, React Navigation, SQLite (public domain), Ionicons (MIT). Server: FastAPI, Uvicorn, Pydantic (MIT/BSD), segno (BSD).</T>
        </Card>
      ) : null}
    </Screen>
  );
}
