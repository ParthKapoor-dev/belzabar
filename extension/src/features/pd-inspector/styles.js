// Shadow-DOM stylesheet for the PD Inspector overlay.
//
// Lives in a closed-ish shadow root so the published page's CSS and the
// overlay's CSS can never bleed into each other.

export const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

.pdi-icon {
  position: fixed; left: 16px; bottom: 16px;
  width: 34px; height: 34px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: #1e1e22; color: #7dd3fc;
  border: 1px solid #3a3a42; cursor: pointer;
  opacity: 0.35; transition: opacity 0.15s ease, transform 0.1s ease;
  pointer-events: auto; user-select: none; font-size: 16px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.4);
}
.pdi-icon:hover { opacity: 1; transform: scale(1.05); }
.pdi-icon.pdi-active { opacity: 1; color: #fbbf24; border-color: #fbbf24; }

.pdi-panel {
  position: fixed; left: 16px; bottom: 16px;
  width: 380px; max-height: 72vh;
  display: none; flex-direction: column;
  background: #1e1e22; color: #d4d4d8;
  border: 1px solid #3a3a42; border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.55);
  pointer-events: auto; font-size: 12px; overflow: hidden;
}
.pdi-panel.pdi-open { display: flex; }

.pdi-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 11px; border-bottom: 1px solid #3a3a42;
  background: #26262b;
}
.pdi-head .pdi-title { font-weight: 700; color: #7dd3fc; flex: 1; }
.pdi-head .pdi-x {
  cursor: pointer; color: #9ca3af; font-size: 15px; line-height: 1;
  padding: 2px 5px; border-radius: 4px;
}
.pdi-head .pdi-x:hover { background: #3a3a42; color: #fff; }

.pdi-info { padding: 9px 11px; border-bottom: 1px solid #2e2e34; }
.pdi-info .pdi-row { display: flex; gap: 8px; margin: 3px 0; }
.pdi-info .pdi-k { color: #6b7280; min-width: 78px; }
.pdi-info .pdi-v { color: #d4d4d8; word-break: break-all; flex: 1; }
.pdi-info .pdi-v.pdi-copy { cursor: pointer; }
.pdi-info .pdi-v.pdi-copy:hover { color: #7dd3fc; }

.pdi-actions { display: flex; gap: 7px; padding: 9px 11px; border-bottom: 1px solid #2e2e34; }
.pdi-btn {
  flex: 1; padding: 6px 8px; border-radius: 5px; cursor: pointer;
  background: #2e2e34; color: #d4d4d8; border: 1px solid #3a3a42;
  font-size: 11px; text-align: center;
}
.pdi-btn:hover { background: #3a3a42; }
.pdi-btn.pdi-toggle-on { background: #fbbf24; color: #1e1e22; border-color: #fbbf24; font-weight: 700; }
.pdi-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.pdi-treewrap { overflow: auto; flex: 1; padding: 5px 0; }
.pdi-tree-empty { padding: 14px 11px; color: #6b7280; }

.pdi-node {
  display: flex; align-items: center; gap: 5px;
  padding: 2px 8px; cursor: pointer; white-space: nowrap;
}
.pdi-node:hover { background: #2e2e34; }
.pdi-node.pdi-sel { background: #33414a; }
.pdi-caret {
  width: 11px; color: #6b7280; font-size: 9px; flex: none; text-align: center;
}
.pdi-caret.pdi-leaf { visibility: hidden; }
.pdi-badge {
  flex: none; font-size: 9px; font-weight: 700; padding: 1px 4px;
  border-radius: 3px; background: #3a3a42; color: #9ca3af;
}
.pdi-badge.pdi-k-FORM_FIELD { background: #1e3a5f; color: #7dd3fc; }
.pdi-badge.pdi-k-DATA_TABLE { background: #3a2a5f; color: #c4b5fd; }
.pdi-badge.pdi-k-BUTTON     { background: #1e4a3a; color: #6ee7b7; }
.pdi-badge.pdi-k-SYMBOL     { background: #5f3a1e; color: #fdba74; }
.pdi-label { overflow: hidden; text-overflow: ellipsis; flex: 1; }
.pdi-vis { flex: none; font-size: 9px; padding: 1px 4px; border-radius: 3px; }
.pdi-vis.pdi-vis-bound  { background: #4a3a10; color: #fbbf24; }
.pdi-vis.pdi-vis-hidden { background: #4a1e1e; color: #f87171; }

.pdi-detail {
  padding: 6px 10px 8px 24px; background: #26262b;
  border-bottom: 1px solid #2e2e34; white-space: normal;
}
.pdi-detail .pdi-d-row { margin: 3px 0; display: flex; gap: 7px; }
.pdi-detail .pdi-d-k { color: #6b7280; min-width: 56px; flex: none; }
.pdi-detail .pdi-d-v { color: #d4d4d8; word-break: break-all; }
.pdi-detail .pdi-expr {
  color: #fbbf24; background: #1e1e22; padding: 4px 6px;
  border-radius: 4px; display: block; margin-top: 2px; word-break: break-all;
}
.pdi-detail .pdi-d-copy { cursor: pointer; color: #7dd3fc; }

/* inspect-mode page overlays */
.pdi-highlight {
  position: fixed; pointer-events: none; z-index: 2147483640;
  border: 2px solid #fbbf24; background: rgba(251,191,36,0.12);
  border-radius: 2px; display: none;
}
.pdi-tip {
  position: fixed; pointer-events: none; z-index: 2147483645;
  background: #1e1e22; color: #d4d4d8; border: 1px solid #fbbf24;
  border-radius: 5px; padding: 5px 8px; font-size: 11px;
  max-width: 320px; display: none; box-shadow: 0 3px 10px rgba(0,0,0,0.5);
}
.pdi-tip .pdi-tip-kind { color: #fbbf24; font-weight: 700; }
.pdi-tip .pdi-tip-id { color: #7dd3fc; word-break: break-all; }
.pdi-tip .pdi-tip-note { color: #9ca3af; }
`;
