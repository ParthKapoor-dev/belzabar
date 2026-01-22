# Git History

## [Unreleased]
### Added
- Implemented global `--llm` flag for machine-readable output.
- Created `lib/display.ts` to centralize output handling.
- Refactored `fetch-method`, `show-method`, and `test-method` to use `DisplayManager`.
- Updated `bin/cli.ts` to parse `--llm` flag and configure `DisplayManager`.

### Changed
- Replaced direct `console.log` calls with `DisplayManager` methods in refactored commands.
- Optimized `show-method` and `test-method` outputs for LLM consumption (JSON vs ASCII/Text).
