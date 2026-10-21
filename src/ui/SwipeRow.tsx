/**
 * Swipe actions for a library row: swipe right for the primary action (archive /
 * restore), swipe left for the rest (add to collection, delete). The same
 * actions are also passed to the card as TalkBack accessibility actions.
 */

import { Ionicons } from '@expo/vector-icons';
import type React from 'react';
import { useRef } from 'react';
import { Pressable, View } from 'react-native';
import Swipeable from 'react-native-gesture-handler/Swipeable';
import type { RowAction } from './ItemCard';
import { T, type IconName } from './components';
import { radius, space, useTheme } from './theme';

export interface SwipeAction extends RowAction {
  icon: IconName;
  tone: 'accent' | 'danger' | 'info';
}

function ActionButton({ action, close }: { action: SwipeAction; close: () => void }) {
  const { c } = useTheme();
  const bg = action.tone === 'danger' ? c.danger : action.tone === 'accent' ? c.accent : c.info;
  return (
    <Pressable
      onPress={() => { close(); action.run(); }}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      style={{ width: 88, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', borderRadius: radius.lg, marginLeft: space.xs, marginBottom: space.sm }}
    >
      <Ionicons name={action.icon} size={22} color="#fff" />
      <T v="caption" color="#fff" style={{ marginTop: 2, fontWeight: '600' }}>{action.label}</T>
    </Pressable>
  );
}

export function SwipeRow({ left, right, children, enabled = true }: { left?: SwipeAction; right?: SwipeAction[]; children: React.ReactNode; enabled?: boolean }) {
  const ref = useRef<Swipeable>(null);
  const close = () => ref.current?.close();
  if (!enabled) return <>{children}</>;
  return (
    <Swipeable
      ref={ref}
      friction={1.6}
      leftThreshold={64}
      rightThreshold={48}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={left ? () => <View style={{ flexDirection: 'row' }}><ActionButton action={left} close={close} /></View> : undefined}
      renderRightActions={right?.length ? () => <View style={{ flexDirection: 'row' }}>{right.map((a) => <ActionButton key={a.name} action={a} close={close} />)}</View> : undefined}
      // A full swipe right runs the primary action directly.
      onSwipeableOpen={(direction) => { if (direction === 'left' && left) { close(); left.run(); } }}
    >
      {children}
    </Swipeable>
  );
}
