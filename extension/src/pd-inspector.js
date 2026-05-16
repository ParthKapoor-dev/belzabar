// PD Inspector content-script engine — loaded only on published /pages/* pages.
//
// The UI is the DevTools "PD Inspector" panel; this script is the page-side
// engine it talks to (config fetch, component-nesting tree, DOM correlation,
// and on-page inspect highlighting).

import { startEngine } from './features/pd-inspector/engine.js';

startEngine();
