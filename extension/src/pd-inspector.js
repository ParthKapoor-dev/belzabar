// PD Inspector content script — loaded only on published app pages (/pages/*).
//
// Surfaces Page Designer structure on a published page: page identity, a deep
// link into the PD designer, the full config tree (including conditionally
// hidden nodes and their visibility expressions), and a point-and-identify
// inspect mode. Standalone — it shares no code with the designer bundles.

import { startPdInspector } from './features/pd-inspector/index.js';

startPdInspector();
