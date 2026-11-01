import { initializeTelemetry } from './telemetry';
import { mount } from 'svelte';
import '@fontsource-variable/manrope';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './style.css';
import App from './App.svelte';

initializeTelemetry();

mount(App, { target: document.getElementById('app')! });
