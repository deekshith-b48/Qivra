/**
 * Colourful 3D emoji from Microsoft's Fluent Emoji set (MIT, assets/emoji/LICENSE-fluentui-emoji.txt),
 * bundled so they look the same on every phone. Decorative: the text next to them carries the meaning.
 */

import { Image } from 'react-native';

const SOURCES = {
  wave: require('../../assets/emoji/wave.png'),
  sparkles: require('../../assets/emoji/sparkles.png'),
  link: require('../../assets/emoji/link.png'),
  memo: require('../../assets/emoji/memo.png'),
  mic: require('../../assets/emoji/mic.png'),
  paperclip: require('../../assets/emoji/paperclip.png'),
  books: require('../../assets/emoji/books.png'),
  cards: require('../../assets/emoji/cards.png'),
  chart: require('../../assets/emoji/chart.png'),
  brain: require('../../assets/emoji/brain.png'),
  satellite: require('../../assets/emoji/satellite.png'),
  lock: require('../../assets/emoji/lock.png'),
  gear: require('../../assets/emoji/gear.png'),
  check: require('../../assets/emoji/check.png'),
} as const;

export type EmojiName = keyof typeof SOURCES;

export function Emoji({ name, size = 22 }: { name: EmojiName; size?: number }) {
  return <Image source={SOURCES[name]} style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}
