// Page Designer content script — loaded only on /ui-designer/*.
//
// PD pages get the route-agnostic features only; AD-only features (JSON editor,
// curl autofill) are not even bundled here.

import { startTitleUpdaterFeature } from './features/title-updater/index.js';
import { startRunTestShortcutFeature } from './features/keyboard/shortcuts.js';
import { startOutputCopyFeature } from './features/output-copy/index.js';
import { startTextareaEditorFeature } from './features/textarea-editor/index.js';
import { bootstrap } from './core/bootstrap.js';

bootstrap(
  {
    titleUpdater: startTitleUpdaterFeature,
    runTestShortcut: startRunTestShortcutFeature,
    outputCopy: startOutputCopyFeature,
    textareaEditor: startTextareaEditorFeature
  },
  { curlAutofill: false }
);
