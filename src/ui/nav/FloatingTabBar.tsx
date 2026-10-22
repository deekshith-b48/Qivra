/**
 * Floating bottom navigation, used on every main screen.
 *
 * A rounded glass capsule holds the tabs. The active tab expands into a lighter
 * pill showing its icon and label, and the others show an outline icon only.
 * A separate round "+" action with a gradient and soft glow sits to the right.
 * Use it as the bottom-tabs `tabBar`; `useTabBarInset()` tells screens how much
 * space to leave at the bottom so content is never hidden behind it.
 */

import { Ionicons } from '@expo/vector-icons';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useState } from 'react';
import { Keyboard, LayoutAnimation, Platform, Pressable, StyleSheet, Text, UIManager, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { shadow, space, type, useTheme } from '../theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) UIManager.setLayoutAnimationEnabledExperimental(true);

export type TabIcon = keyof typeof Ionicons.glyphMap;
export interface TabSpec {
  label: string;
  /** [active, inactive] icons. */
  icon: [TabIcon, TabIcon];
  /** Small number shown on the tab (e.g. cards due). */
  badge?: number;
}

export const BAR_HEIGHT = 64;
const BAR_GAP = 12;

/** Bottom space a screen must leave for the floating bar. */
export function useTabBarInset(): number {
  const insets = useSafeAreaInsets();
  return BAR_HEIGHT + BAR_GAP * 2 + Math.max(insets.bottom, 8);
}

export function FloatingTabBar({ state, navigation, descriptors, tabs, onAdd, addLabel = 'Save something' }: BottomTabBarProps & {
  tabs: Record<string, TabSpec>;
  onAdd: () => void;
  addLabel?: string;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(false);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // A screen hides the bar with React Navigation's own option: tabBarStyle: { display: 'none' }.
  const focusedStyle = descriptors[state.routes[state.index]?.key]?.options.tabBarStyle as { display?: string } | undefined;
  if (keyboard || focusedStyle?.display === 'none') return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: Math.max(insets.bottom, 8) + BAR_GAP }]}>
      <View style={[styles.capsule, { backgroundColor: c.navGlass, borderColor: c.navBorder }, shadow.float, c.scheme === 'dark' && { shadowOpacity: 0.4 }]} accessibilityRole="tablist">
        {state.routes.map((route, index) => {
          const spec = tabs[route.name];
          if (!spec) return null;
          const focused = state.index === index;
          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!focused && !event.defaultPrevented) {
              LayoutAnimation.configureNext(LayoutAnimation.create(220, LayoutAnimation.Types.easeInEaseOut, LayoutAnimation.Properties.scaleXY));
              navigation.navigate(route.name, route.params);
            }
          };
          const label = descriptors[route.key]?.options.tabBarAccessibilityLabel ?? spec.label;
          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              onLongPress={() => navigation.emit({ type: 'tabLongPress', target: route.key })}
              accessibilityRole="tab"
              accessibilityLabel={spec.badge ? `${label}, ${spec.badge} due` : label}
              accessibilityState={{ selected: focused }}
              style={[styles.tab, focused && [styles.activeTab, { backgroundColor: c.navActive }, c.scheme === 'light' && shadow.button]]}
            >
              <View>
                <Ionicons name={spec.icon[focused ? 0 : 1]} size={22} color={focused ? c.onNavActive : c.navIcon} />
                {spec.badge && !focused ? (
                  <View style={[styles.badge, { backgroundColor: c.fabGlow, borderColor: c.navGlass }]}>
                    <Text style={styles.badgeText}>{spec.badge > 9 ? '9+' : spec.badge}</Text>
                  </View>
                ) : null}
              </View>
              {focused ? <Text style={[type.subtitle, { color: c.onNavActive, fontSize: 15 }]} numberOfLines={1}>{spec.label}</Text> : null}
            </Pressable>
          );
        })}
      </View>
      <Pressable onPress={onAdd} accessibilityRole="button" accessibilityLabel={addLabel} accessibilityHint="Paste a link, write a note, record a voice note or import a file"
        style={({ pressed }) => [styles.fab, { shadowColor: c.fabGlow }, pressed && { transform: [{ scale: 0.95 }] }]}>
        <LinearGradient key={c.scheme} colors={c.fabGradient} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={styles.fabFill}>
          <Ionicons name="add" size={32} color="#FFFFFF" />
        </LinearGradient>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: space.lg, right: space.lg, flexDirection: 'row', alignItems: 'center', gap: space.md },
  capsule: {
    flex: 1, height: BAR_HEIGHT, borderRadius: BAR_HEIGHT / 2, borderWidth: 1.5, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingHorizontal: 6,
  },
  tab: { height: BAR_HEIGHT - 12, minWidth: 52, borderRadius: (BAR_HEIGHT - 12) / 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 14 },
  activeTab: { paddingHorizontal: 18 },
  badge: { position: 'absolute', top: -5, right: -9, minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  badgeText: { color: '#FFFFFF', fontSize: 9, fontWeight: '800' },
  fab: { width: BAR_HEIGHT, height: BAR_HEIGHT, borderRadius: BAR_HEIGHT / 2, shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 10 },
  fabFill: { flex: 1, borderRadius: BAR_HEIGHT / 2, alignItems: 'center', justifyContent: 'center' },
});
