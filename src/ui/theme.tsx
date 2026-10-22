/**
 * Theme provider. All colours, gradients, radii, shadows and type live in
 * ./tokens.ts; this file picks the light or dark palette and re-exports them.
 */

import type React from 'react';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { subscribe } from '../services/events';
import { getSettings } from '../services/settings';
import { dark, light, type Palette } from './tokens';

export { dark, familyFor, fonts, light, palettes, radius, shadow, space, type } from './tokens';
export type { Palette } from './tokens';

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
