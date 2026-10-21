import { Ionicons } from '@expo/vector-icons';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { DarkTheme, DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { RootStackParamList, TabParamList } from './src/navigation/types';
import AboutScreen from './src/screens/AboutScreen';
import AgentScreen from './src/screens/AgentScreen';
import AiProvidersScreen from './src/screens/AiProvidersScreen';
import VoiceSettingsScreen from './src/screens/VoiceSettingsScreen';
import CaptureScreen from './src/screens/CaptureScreen';
import CollectionsScreen from './src/screens/CollectionsScreen';
import ConflictsScreen from './src/screens/ConflictsScreen';
import ConnectServerScreen from './src/screens/ConnectServerScreen';
import ItemDetailScreen from './src/screens/ItemDetailScreen';
import JobsScreen from './src/screens/JobsScreen';
import LibraryScreen from './src/screens/LibraryScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import PrivacyStorageScreen from './src/screens/PrivacyStorageScreen';
import QrScanScreen from './src/screens/QrScanScreen';
import ReportDetailScreen from './src/screens/ReportDetailScreen';
import ReportsScreen from './src/screens/ReportsScreen';
import SearchScreen from './src/screens/SearchScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ShareReceiptScreen from './src/screens/ShareReceiptScreen';
import TodayScreen from './src/screens/TodayScreen';
import TranscriptImportScreen from './src/screens/TranscriptImportScreen';
import { boot, onResume, type BootResult } from './src/services/bootstrap';
import { Banner, Loading, Screen } from './src/ui/components';
import { ThemeProvider, useTheme } from './src/ui/theme';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();
const nav = createNavigationContainerRef<RootStackParamList>();

const TAB_ICONS: Record<keyof TabParamList, [keyof typeof Ionicons.glyphMap, keyof typeof Ionicons.glyphMap]> = {
  Today: ['sunny', 'sunny-outline'],
  Library: ['library', 'library-outline'],
  Search: ['search', 'search-outline'],
  Agent: ['chatbubbles', 'chatbubbles-outline'],
  Reports: ['document-text', 'document-text-outline'],
};

function MainTabs() {
  const { c } = useTheme();
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: c.text,
        tabBarInactiveTintColor: c.textFaint,
        tabBarStyle: { backgroundColor: c.bg, borderTopColor: c.border, minHeight: 60 },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarIcon: ({ focused, color, size }) => <Ionicons name={TAB_ICONS[route.name][focused ? 0 : 1]} size={size} color={color} />,
        tabBarAccessibilityLabel: route.name === 'Agent' ? 'AI Agent' : route.name,
      })}
    >
      <Tabs.Screen name="Today" component={TodayScreen} />
      <Tabs.Screen name="Library" component={LibraryScreen} />
      <Tabs.Screen name="Search" component={SearchScreen} />
      <Tabs.Screen name="Agent" component={AgentScreen} options={{ title: 'AI Agent' }} />
      <Tabs.Screen name="Reports" component={ReportsScreen} />
    </Tabs.Navigator>
  );
}

function showShare(shared: BootResult['shared']) {
  if (!shared.results.length && !shared.rejected.length) return;
  const single = shared.results.length === 1 && !shared.rejected.length && shared.results[0].itemId && !shared.results[0].error ? shared.results[0].itemId : null;
  // One shared item opens straight on its own page (live progress); several, or failures, show a receipt.
  const go = () => (nav.isReady() ? (single ? nav.navigate('ItemDetail', { id: single }) : nav.navigate('ShareReceipt', shared)) : setTimeout(go, 100));
  go();
}

function Root() {
  const { c } = useTheme();
  const [state, setState] = useState<{ ready: boolean; boot?: BootResult; error?: string }>({ ready: false });

  useEffect(() => {
    boot()
      .then((b) => {
        setState({ ready: true, boot: b });
        showShare(b.shared);
      })
      .catch((e: Error) => setState({ ready: true, error: e.message }));
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void onResume().then(showShare);
    });
    // The native share activity opens qivra://share after writing the envelope to the inbox.
    const linkSub = Linking.addEventListener('url', ({ url }) => {
      if (url.includes('share')) void onResume().then(showShare);
    });
    return () => {
      appSub.remove();
      linkSub.remove();
    };
  }, []);

  if (!state.ready) return <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: 'center' }}><Loading label="Opening your library" /></View>;
  if (state.error) {
    return (
      <Screen>
        <Banner tone="danger" title="Qivra could not open its database" body={`${state.error}\nYour data has not been modified. Restart the app; if this persists, export logs are not collected — reinstalling keeps data unless you clear storage.`} />
      </Screen>
    );
  }
  const base = c.scheme === 'dark' ? DarkTheme : DefaultTheme;
  return (
    <NavigationContainer
      ref={nav}
      theme={{ ...base, colors: { ...base.colors, background: c.bg, card: c.bg, text: c.text, border: c.border, primary: c.text } }}
      linking={{ prefixes: ['qivra://'], config: { screens: { Main: { screens: { Today: 'today', Library: 'library', Search: 'search', Agent: 'agent', Reports: 'reports' } }, ConnectServer: 'connect' } } }}
    >
      <StatusBar style={c.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack.Navigator initialRouteName={state.boot?.onboarded ? 'Main' : 'Onboarding'} screenOptions={{ headerShown: false, animation: 'slide_from_right', contentStyle: { backgroundColor: c.bg } }}>
        <Stack.Screen name="Onboarding" component={OnboardingScreen} />
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen name="ItemDetail" component={ItemDetailScreen} />
        <Stack.Screen name="Capture" component={CaptureScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="TranscriptImport" component={TranscriptImportScreen} />
        <Stack.Screen name="ShareReceipt" component={ShareReceiptScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="Collections" component={CollectionsScreen} />
        <Stack.Screen name="ReportDetail" component={ReportDetailScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="ConnectServer" component={ConnectServerScreen} />
        <Stack.Screen name="QrScan" component={QrScanScreen} options={{ animation: 'slide_from_bottom' }} />
        <Stack.Screen name="AiProviders" component={AiProvidersScreen} />
        <Stack.Screen name="VoiceSettings" component={VoiceSettingsScreen} />
        <Stack.Screen name="PrivacyStorage" component={PrivacyStorageScreen} />
        <Stack.Screen name="Jobs" component={JobsScreen} />
        <Stack.Screen name="Conflicts" component={ConflictsScreen} />
        <Stack.Screen name="About" component={AboutScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Root />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
