import { fireEvent, render, screen } from '@testing-library/react-native';
import { FloatingTabBar, type TabSpec } from '../../src/ui/nav/FloatingTabBar';
import { ThemeProvider } from '../../src/ui/theme';

const tabs: Record<string, TabSpec> = {
  Today: { label: 'Home', icon: ['home', 'home-outline'] },
  Glance: { label: 'Glance', icon: ['grid', 'grid-outline'], badge: 3 },
  Library: { label: 'Library', icon: ['folder', 'folder-outline'] },
  Agent: { label: 'Ask', icon: ['chatbubble-ellipses', 'chatbubble-ellipses-outline'] },
};

function setup(index = 0) {
  const routes = Object.keys(tabs).map((name) => ({ key: `${name}-k`, name, params: undefined }));
  const navigation = { emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() };
  const onAdd = jest.fn();
  render(
    <ThemeProvider>
      <FloatingTabBar state={{ index, routes } as never} navigation={navigation as never} descriptors={{} as never} insets={{ top: 0, bottom: 0, left: 0, right: 0 }} tabs={tabs} onAdd={onAdd} />
    </ThemeProvider>,
  );
  return { navigation, onAdd };
}

test('four tabs; only the active one shows its label; the + action is separate', () => {
  const { navigation, onAdd } = setup(0);
  const all = screen.getAllByRole('tab');
  expect(all.map((t) => t.props.accessibilityLabel)).toEqual(['Home', 'Glance, 3 due', 'Library', 'Ask']);
  expect(all[0].props.accessibilityState).toEqual({ selected: true });
  expect(screen.getByText('Home')).toBeTruthy();
  expect(screen.queryByText('Library')).toBeNull(); // inactive tabs are icon-only
  fireEvent.press(all[2]);
  expect(navigation.navigate).toHaveBeenCalledWith('Library', undefined);
  fireEvent.press(screen.getByRole('button', { name: 'Save something' }));
  expect(onAdd).toHaveBeenCalled();
});

test('pressing the active tab does not navigate again', () => {
  const { navigation } = setup(3);
  expect(screen.getByText('Ask')).toBeTruthy();
  fireEvent.press(screen.getAllByRole('tab')[3]);
  expect(navigation.navigate).not.toHaveBeenCalled();
});

test('hidden when the focused screen asks for it (Ask during a chat)', () => {
  const routes = Object.keys(tabs).map((name) => ({ key: `${name}-k`, name, params: undefined }));
  const descriptors = { 'Agent-k': { options: { tabBarStyle: { display: 'none' } } } };
  render(
    <ThemeProvider>
      <FloatingTabBar state={{ index: 3, routes } as never} navigation={{ emit: jest.fn(), navigate: jest.fn() } as never} descriptors={descriptors as never} insets={{ top: 0, bottom: 0, left: 0, right: 0 }} tabs={tabs} onAdd={jest.fn()} />
    </ThemeProvider>,
  );
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
});
