import { registerRootComponent } from 'expo';
import App from './App';
import { defineBackgroundTask } from './src/services/background';

// Background tasks must be defined at module scope, before the app renders.
defineBackgroundTask();

registerRootComponent(App);
