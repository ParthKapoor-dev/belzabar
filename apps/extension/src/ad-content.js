// Automation Designer content script — loaded only on /automation-designer/*.

import { startTitleUpdaterFeature } from './features/title-updater/index.js';
import { startRunTestShortcutFeature } from './features/keyboard/shortcuts.js';
import { startJSONFeature } from './features/json-editor/index.js';
import { startOutputCopyFeature } from './features/output-copy/index.js';
import { startTextareaEditorFeature } from './features/textarea-editor/index.js';
import { bootstrap } from './core/bootstrap.js';

bootstrap(
  {
    titleUpdater: startTitleUpdaterFeature,
    runTestShortcut: startRunTestShortcutFeature,
    jsonEditor: startJSONFeature,
    outputCopy: startOutputCopyFeature,
    textareaEditor: startTextareaEditorFeature
  },
  { curlAutofill: true }
);
