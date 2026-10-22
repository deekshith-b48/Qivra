import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { ErrorBoundary } from '../../src/ui/components';
import { ThemeProvider } from '../../src/ui/theme';

let broken = true;
function Flaky() {
  if (broken) throw new Error('bad item data');
  return <Text>All good</Text>;
}

test('a render crash shows an error with Retry instead of closing the app', () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined); // React logs the caught error
  render(<ThemeProvider><ErrorBoundary><Flaky /></ErrorBoundary></ThemeProvider>);
  expect(screen.getByText('Something went wrong')).toBeTruthy();
  expect(screen.getByText('bad item data')).toBeTruthy();
  broken = false;
  fireEvent.press(screen.getByText('Retry'));
  expect(screen.getByText('All good')).toBeTruthy();
});
