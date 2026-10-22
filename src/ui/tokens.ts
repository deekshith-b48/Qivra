/**
 * Qivra design tokens: the single source for colours, gradients, radii,
 * shadows, spacing and type.
 *
 * Light mode follows a soft, airy system: grey-white gradient background,
 * white rounded cards, very soft wide shadows, black pill controls, and red
 * only on the floating "+" action and destructive actions.
 * Dark mode uses the crimson palette: Rich Black #221F1F surfaces on near-black
 * with a deep-red glow, Netflix Crimson #E50914 for primary actions, Deep Red
 * #B81D24 for gradients, Soft White #F5F5F1 text.
 * Contrast is checked by __tests__/core/tokens.test.ts (text ≥ 7:1, muted ≥ 4.5:1).
 */

import type { TextStyle } from 'react-native';

export interface Palette {
  scheme: 'light' | 'dark';
  /** Flat background (also the status bar / navigation background). */
  bg: string;
  /** Screen background gradient, top → bottom (always three stops, at 0 / 32% / 100%). */
  bgGradient: readonly [string, string, string];
  surface: string; // cards
  surfaceAlt: string; // inner tiles, inputs, tonal buttons
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  primary: string; // filled buttons, active segments
  onPrimary: string;
  /** Filled-button gradient (dark mode: crimson → deep red). */
  primaryGradient: readonly [string, string];
  accent: string; // text-safe accent for links, pills, highlights
  accentSoft: string;
  onAccentSoft: string;
  positive: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  info: string;
  infoSoft: string;
  overlay: string;
  /** Floating navigation bar. */
  navGlass: string;
  navBorder: string;
  navActive: string;
  onNavActive: string;
  navIcon: string;
  /** The floating "+" action: gradient and glow colour. */
  fabGradient: readonly [string, string];
  fabGlow: string;
  /** Card elevation: soft shadow in light mode, a hairline border in dark mode. */
  cardShadow: boolean;
  /** Dark veil over photos/video (badges, play buttons) and the text on it. */
  scrim: string;
  onMedia: string;
  /** Keyword highlighter background. */
  highlight: string;
  onHighlight: string;
  /** Apple-style system colours for feature tiles, stats and topic chips (icons and soft backgrounds, not body text). */
  tint: Record<TintName, string>;
}

export type TintName = 'blue' | 'green' | 'orange' | 'pink' | 'purple' | 'teal' | 'indigo' | 'yellow' | 'red' | 'gray';

/** A tint at ~14% opacity, for soft card and chip backgrounds. */
export const soft = (hex: string) => `${hex}24`;

export const light: Palette = {
  scheme: 'light',
  bg: '#EEF0F3',
  bgGradient: ['#F8F9FB', '#F1F3F5', '#ECEEF1'],
  surface: '#FFFFFF',
  surfaceAlt: '#F3F4F6',
  border: '#E5E7EB',
  text: '#0E0F11',
  textMuted: '#5B616B',
  textFaint: '#80868F',
  primary: '#0E0F11',
  onPrimary: '#FFFFFF',
  primaryGradient: ['#24262B', '#0E0F11'],
  // iOS blue, deepened for text contrast (system #007AFF is 4.0:1 on white).
  accent: '#0060DF',
  accentSoft: '#E8F1FF',
  onAccentSoft: '#0050B8',
  positive: '#15803D',
  danger: '#C8282F',
  dangerSoft: '#FDECEC',
  warning: '#8A4B00',
  warningSoft: '#FFF3DC',
  info: '#1D4E89',
  infoSoft: '#E6EEF9',
  overlay: 'rgba(14,15,17,0.40)',
  navGlass: 'rgba(244,245,247,0.94)',
  navBorder: '#FFFFFF',
  navActive: '#FFFFFF',
  onNavActive: '#0E0F11',
  navIcon: '#8A9099',
  fabGradient: ['#FF7272', '#EF4B52'],
  fabGlow: '#EF4B52',
  cardShadow: true,
  scrim: 'rgba(14,15,17,0.62)',
  onMedia: '#FFFFFF',
  highlight: '#FFEFA8',
  onHighlight: '#0E0F11',
  tint: { blue: '#007AFF', green: '#34C759', orange: '#FF9500', pink: '#FF2D55', purple: '#AF52DE', teal: '#30B0C7', indigo: '#5856D6', yellow: '#FFCC00', red: '#FF3B30', gray: '#8E8E93' },
};

export const dark: Palette = {
  scheme: 'dark',
  bg: '#0B0A0A',
  bgGradient: ['#2A0B0D', '#120C0C', '#0B0A0A'],
  surface: '#221F1F',
  surfaceAlt: '#2C2828',
  border: '#3A3434',
  text: '#F5F5F1',
  textMuted: '#BDB6B4',
  textFaint: '#958D8B',
  primary: '#E50914',
  onPrimary: '#FFFFFF',
  primaryGradient: ['#E50914', '#B81D24'],
  accent: '#FF5A63',
  accentSoft: '#3A1416',
  onAccentSoft: '#FFD9DB',
  positive: '#5BD38A',
  danger: '#FF6B6B',
  dangerSoft: '#3A1416',
  warning: '#FFC266',
  warningSoft: '#3A2A0E',
  info: '#9CC3F5',
  infoSoft: '#15233A',
  overlay: 'rgba(0,0,0,0.65)',
  navGlass: 'rgba(34,31,31,0.94)',
  navBorder: '#3A3434',
  navActive: '#F5F5F1',
  onNavActive: '#221F1F',
  navIcon: '#A39C9A',
  fabGradient: ['#FF3B45', '#B81D24'],
  fabGlow: '#E50914',
  cardShadow: false,
  scrim: 'rgba(11,10,10,0.66)',
  onMedia: '#F5F5F1',
  highlight: '#5A1A1E',
  onHighlight: '#FFE3E5',
  tint: { blue: '#0A84FF', green: '#30D158', orange: '#FF9F0A', pink: '#FF375F', purple: '#BF5AF2', teal: '#64D2FF', indigo: '#5E5CE6', yellow: '#FFD60A', red: '#FF453A', gray: '#8E8E93' },
};

export const palettes = { light, dark } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 10, md: 16, lg: 22, card: 22, tile: 16, input: 16, sheet: 28, pill: 999 } as const;

/** Soft, wide shadows (light mode). Dark mode uses borders instead. */
export const shadow = {
  card: { shadowColor: '#1A1D23', shadowOpacity: 0.06, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 3 },
  float: { shadowColor: '#1A1D23', shadowOpacity: 0.1, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 8 },
  button: { shadowColor: '#1A1D23', shadowOpacity: 0.08, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 2 },
} as const;

/** Plus Jakarta Sans, one family per weight (loaded in App.tsx). */
export const fonts = {
  regular: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
  extrabold: 'PlusJakartaSans_800ExtraBold',
} as const;

/** The font family for a weight, so custom fonts render real bold instead of faux bold. */
export function familyFor(weight: TextStyle['fontWeight'] | undefined): string {
  const w = typeof weight === 'number' ? weight : weight === 'bold' ? 700 : weight === 'normal' || !weight ? 400 : Number(weight);
  if (w >= 800) return fonts.extrabold;
  if (w >= 700) return fonts.bold;
  if (w >= 600) return fonts.semibold;
  if (w >= 500) return fonts.medium;
  return fonts.regular;
}

export const type = {
  display: { fontSize: 28, lineHeight: 34, fontFamily: fonts.bold, letterSpacing: -0.6 },
  title: { fontSize: 20, lineHeight: 26, fontFamily: fonts.bold, letterSpacing: -0.3 },
  subtitle: { fontSize: 16, lineHeight: 22, fontFamily: fonts.semibold, letterSpacing: -0.1 },
  body: { fontSize: 15, lineHeight: 22, fontFamily: fonts.regular },
  small: { fontSize: 13, lineHeight: 18, fontFamily: fonts.regular },
  caption: { fontSize: 12, lineHeight: 16, fontFamily: fonts.medium, letterSpacing: 0.1 },
  mono: { fontSize: 13, lineHeight: 19, fontFamily: 'monospace' },
} satisfies Record<string, TextStyle>;
