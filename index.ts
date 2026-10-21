import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';
import App from './App';
import { defineBackgroundTask } from './src/services/background';
import { runShareTask, SHARE_TASK_NAME } from './src/services/shareTask';

// Background tasks must be defined at module scope, before the app renders.
defineBackgroundTask();
// Started by the native QivraShareTaskService after a share, without opening the app.
AppRegistry.registerHeadlessTask(SHARE_TASK_NAME, () => async () => {
  await runShareTask();
});

registerRootComponent(App);
