/**
 * Qivra design tokens: black/white foundation, restrained light-green accent.
 * Contrast: text ≥ 7:1, muted text ≥ 4.5:1, accent text ≥ 4.5:1 in both themes.
 */

import type React from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { subscribe } from '../services/events';
import { getSettings } from '../services/settings';

export interface Palette {
  scheme: 'light' | 'dark';
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  textFaint: string;
  primary: string; // filled buttons (ink)
  onPrimary: string;
  accent: string; // green, text-safe
  accentSoft: string; // green tint for chips/badges
  onAccentSoft: string;
  danger: string;
  dangerSoft: string;
  warning: string;
  warningSoft: string;
  info: string;
  infoSoft: string;
  overlay: string;
}

export const light: Palette = {
  scheme: 'light',
  bg: '#FFFFFF',
  surface: '#F6F6F4',
  surfaceAlt: '#EDEDEA',
  border: '#E2E2DE',
  text: '#0B0B0B',
  textMuted: '#55554F',
  textFaint: '#77776F',
  primary: '#0B0B0B',
  onPrimary: '#FFFFFF',
  accent: '#1B7A35',
  accentSoft: '#DCF5D3',
  onAccentSoft: '#0F4A20',
  danger: '#B42318',
  dangerSoft: '#FDE8E6',
  warning: '#8A4B00',
  warningSoft: '#FFF1D6',
  info: '#1D4E89',
  infoSoft: '#E3EEFB',
  overlay: 'rgba(0,0,0,0.45)',
};

export const dark: Palette = {
  scheme: 'dark',
  bg: '#0A0A0A',
  surface: '#141414',
  surfaceAlt: '#1D1D1C',
  border: '#2B2B29',
  text: '#F4F4F1',
  textMuted: '#B0B0A9',
  textFaint: '#8E8E87',
  primary: '#F4F4F1',
  onPrimary: '#0A0A0A',
  accent: '#9BE59B',
  accentSoft: '#1C3A1F',
  onAccentSoft: '#C9F5C3',
  danger: '#FF8A7A',
  dangerSoft: '#3A1512',
  warning: '#FFC266',
  warningSoft: '#3A2A0E',
  info: '#93BFF5',
  infoSoft: '#12243A',
  overlay: 'rgba(0,0,0,0.6)',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

export const type = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const, letterSpacing: -0.4 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600' as const, letterSpacing: -0.2 },
  subtitle: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400' as const },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const, letterSpacing: 0.2 },
  mono: { fontSize: 13, lineHeight: 19, fontFamily: 'monospace' },
};

type Pref = 'system' | 'light' | 'dark';
const ThemeCtx = createContext<{ c: Palette; pref: Pref; setPref: (p: Pref) => void }>({ c: light, pref: 'system', setPref: () => undefined });

export function ThemeProvider({ children, initial = 'system' }: { children: React.ReactNode; initial?: Pref }) {
  const system = useColorScheme();
  const [pref, setPref] = useState<Pref>(initial);
  useEffect(() => {
    const load = async () => {
      try {
        setPref((await getSettings()).theme);
      } catch {
        /* keep current */
      }
    };
    void load();
    return subscribe((t) => {
      if (t === 'settings') void load();
    });
  }, []);
  const c = useMemo(() => ((pref === 'system' ? system : pref) === 'dark' ? dark : light), [pref, system]);
  return <ThemeCtx.Provider value={{ c, pref, setPref }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  return useContext(ThemeCtx);
}
