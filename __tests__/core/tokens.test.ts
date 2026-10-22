import { dark, light, type Palette } from '../../src/ui/tokens';

function lum(hex: string): number {
  const v = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

describe.each([['light', light], ['dark', dark]] as [string, Palette][])('%s palette contrast (WCAG)', (_name, c) => {
  test.each(['bg', 'surface', 'surfaceAlt'] as const)('text on %s ≥ 7:1 and muted ≥ 4.5:1', (bg) => {
    expect(ratio(c.text, c[bg])).toBeGreaterThanOrEqual(7);
    expect(ratio(c.textMuted, c[bg])).toBeGreaterThanOrEqual(4.5);
  });
  test('buttons, accents, nav and status colours are readable', () => {
    expect(ratio(c.onPrimary, c.primary)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c.accent, c.bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c.onAccentSoft, c.accentSoft)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c.onNavActive, c.navActive)).toBeGreaterThanOrEqual(7);
    expect(ratio(c.danger, c.surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(c.onHighlight, c.highlight)).toBeGreaterThanOrEqual(7);
    expect(ratio(c.textFaint, c.surface)).toBeGreaterThanOrEqual(3);
  });
});

test('the dark palette uses the crimson system colours', () => {
  expect(dark.primary).toBe('#E50914');
  expect(dark.surface).toBe('#221F1F');
  expect(dark.text).toBe('#F5F5F1');
  expect(dark.primaryGradient).toEqual(['#E50914', '#B81D24']);
});
