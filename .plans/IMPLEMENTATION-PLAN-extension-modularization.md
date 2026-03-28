# GSD2 Extension Modularization — Implementation Plan
// GSD2 Extension System Modularization
// Jeremy McSpadden <jeremy@fluxlabs.net>

**Created:** 2026-03-28
**Status:** Draft — awaiting review
**Goal:** Make GSD2 lightweight out of the box by extracting optional features into installable extensions, reducing core footprint from 177K LOC to ~15-20K LOC and node_modules from 842 MB to ~450 MB.

---

## Table of Contents

1. [Phase 0: Foundation — Dependency Cleanup & Architecture Fixes](#phase-0)
2. [Phase 1: Extension Install Infrastructure](#phase-1)
3. [Phase 2: Extract Self-Contained Extensions (Tier 1)](#phase-2)
4. [Phase 3: Preferences Service & Tier 2 Extraction](#phase-3)
5. [Phase 4: Skills & Agents as Installable Packs](#phase-4)
6. [Phase 5: GSD Core Decomposition](#phase-5)
7. [Phase 6: AI Provider SDK Lazy Loading](#phase-6)
8. [Phase 7: Barrel Import Optimization](#phase-7)
9. [Risk Register](#risk-register)
10. [Success Metrics](#success-metrics)

---

<a id="phase-0"></a>
## Phase 0: Foundation — Dependency Cleanup & Architecture Fixes

**Goal:** Clean up the dependency graph and fix architecture issues that block clean extraction.
**Effort:** Small (1-2 sessions)
**Risk:** Low
**Dependencies:** None

### 0.1 Remove Unused Root Dependencies

**Files:** `package.json`

| Dependency | Action | Reason |
|-----------|--------|--------|
| `@octokit/rest` | Remove from root deps | Not imported in any source file — only referenced in skill markdown |
| `mime-types` | Move to `packages/pi-tui/package.json` | Only used by pi-tui |
| `get-east-asian-width` | Move to `packages/pi-tui/package.json` | Only used by pi-tui |
| `zod-to-json-schema` | Move to `packages/pi-ai/package.json` | Only used by pi-ai |

**Verification:**
- `npm install` succeeds
- `npm run build` succeeds
- `npm test` passes
- Grep for each package name to confirm no root-level imports remain

### 0.2 Fix Reverse Dependency: shared → gsd

**Problem:** `src/resources/extensions/shared/rtk-session-stats.ts` imports `gsdRoot` from `../gsd/paths.js`, creating a reverse dependency from the utility library back into the GSD extension.

**Fix:**
1. Read `shared/rtk-session-stats.ts` to understand what it needs from `gsd/paths.js`
2. Extract the needed path resolution into `shared/` itself, or pass it as a parameter
3. Remove the `../gsd/paths.js` import from `shared/`

**Files:**
- `src/resources/extensions/shared/rtk-session-stats.ts` — remove gsd import
- `src/resources/extensions/gsd/paths.ts` — no changes needed (still exports for gsd internal use)

**Verification:**
- No imports from `../gsd/` remain in `shared/` directory
- Build passes
- RTK session stats still functions correctly

### 0.3 Fix Bidirectional Coupling: gsd ↔ cmux

**Problem:** `gsd/auto.ts` imports from cmux (`clearCmuxSidebar`, `logCmuxEvent`, `syncCmuxSidebar`), and cmux imports from gsd (`preferences.js`, `types.js`).

**Fix:**
1. Define cmux integration as an event-based contract
2. GSD auto-mode emits events: `cmux:sidebar_sync`, `cmux:event_log`, `cmux:sidebar_clear`
3. cmux subscribes to these events via `pi.on()` hooks
4. Remove direct imports between gsd and cmux in both directions

**Files:**
- `src/resources/extensions/gsd/auto.ts` — replace cmux imports with event emission
- `src/resources/extensions/cmux/index.ts` — subscribe to events instead of importing from gsd
- `src/resources/extensions/gsd/types.ts` — extract shared types to `shared/` if needed by cmux

**Verification:**
- No cross-imports between `gsd/` and `cmux/` in either direction
- cmux sidebar still works in auto-mode
- Build passes

---

<a id="phase-1"></a>
## Phase 1: Extension Install Infrastructure

**Goal:** Add the ability to install, update, and uninstall extensions from npm or git sources.
**Effort:** Medium (2-3 sessions)
**Risk:** Medium
**Dependencies:** None (can run parallel with Phase 0)

### 1.1 Design Extension Package Format

Define what an installable extension package looks like:

```
@gsd/ext-browser-tools/
├── package.json          # npm package metadata
│   ├── name: "@gsd/ext-browser-tools"
│   ├── version: "1.0.0"
│   ├── gsd.extension: true           # marker for gsd extension packages
│   ├── peerDependencies:
│   │   └── "@glittercowboy/gsd": ">=2.60.0"
│   └── gsd.manifest: { ... }         # inline extension-manifest.json
├── extension-manifest.json           # standard manifest (also works standalone)
├── index.ts                          # extension entry point
└── ... other extension files
```

**Design decisions:**
- Extensions are npm packages with a `gsd.extension: true` marker in package.json
- Installed to `~/.gsd/extensions/<package-name>/` (separate from bundled `~/.gsd/agent/extensions/`)
- Extension manifest can be inline in package.json (`gsd.manifest`) or standalone file
- `peerDependencies` declares GSD version compatibility (replaces `requires.platform`)

**Files to create:**
- `src/extension-installer.ts` — install/update/uninstall logic
- Update `src/extension-registry.ts` — add `source: "installed"` type
- Update `src/extension-discovery.ts` — scan `~/.gsd/extensions/` in addition to existing paths

### 1.2 Implement `gsd extensions install <package>`

**Command:** `/gsd extensions install <package>[@version]`

**Flow:**
1. Resolve package name (support `@gsd/ext-*`, npm shorthand, git URL)
2. Create temp directory, run `npm install --prefix <temp> <package>`
3. Validate: check `gsd.extension: true` marker, read manifest, check platform compatibility
4. Copy extension files to `~/.gsd/extensions/<id>/`
5. Symlink `node_modules` for the extension's dependencies
6. Register in registry with `source: "installed"`
7. Notify user to restart or hot-reload

**Files:**
- `src/extension-installer.ts` (new) — ~300 LOC
  - `installExtension(packageSpec: string): Promise<InstallResult>`
  - `uninstallExtension(id: string): Promise<void>`
  - `updateExtension(id: string): Promise<UpdateResult>`
  - `listInstallableExtensions(): Promise<ExtensionInfo[]>`
- `src/resources/extensions/gsd/commands-extensions.ts` — add `install`, `uninstall`, `update` subcommands

### 1.3 Update Extension Discovery for Installed Extensions

**Files:**
- `src/extension-discovery.ts` — add scanning of `~/.gsd/extensions/`
- `src/loader.ts` — include installed extension paths in `GSD_BUNDLED_EXTENSION_PATHS`
- `src/resource-loader.ts` — `buildResourceLoader()` includes installed extensions

**Key behavior:**
- Installed extensions load AFTER bundled extensions
- If an installed extension has the same ID as a bundled one, installed version wins (override)
- Disabled extensions (via registry) are still skipped regardless of source

### 1.4 Implement `gsd extensions update [id]`

- Without ID: checks all installed extensions for updates
- With ID: updates specific extension
- Shows changelog/diff before updating
- Backs up previous version for rollback

### 1.5 Implement `gsd extensions uninstall <id>`

- Removes extension directory from `~/.gsd/extensions/`
- Removes registry entry
- Warns if other extensions depend on it (check `dependencies.extensions` in manifests)

### 1.6 Enforce Extension Dependencies

**File:** `packages/pi-coding-agent/src/core/extensions/loader.ts`

Currently `dependencies.extensions` in manifests is declared but not enforced. Add:
1. Build dependency graph at load time
2. Sort extensions by dependency order
3. Warn (don't error) if a dependency is missing — suggest install command
4. Error if circular dependency detected

**Verification:**
- `gsd extensions install @gsd/ext-context7` works end-to-end
- `gsd extensions list` shows installed extensions with source
- `gsd extensions uninstall context7` removes cleanly
- `gsd extensions update` checks for newer versions
- Build passes, existing tests pass

---

<a id="phase-2"></a>
## Phase 2: Extract Self-Contained Extensions (Tier 1)

**Goal:** Move 8 self-contained extensions out of the bundled set into installable packages.
**Effort:** Medium (2-3 sessions)
**Risk:** Low (these have zero cross-extension coupling)
**Dependencies:** Phase 1 (install infrastructure must exist)

### 2.1 Create Extension Package Template

Create a reusable template/script for extracting a bundled extension into a standalone package:

```bash
# scripts/extract-extension.sh <extension-name>
# 1. Creates package directory structure
# 2. Copies extension files
# 3. Generates package.json with correct deps
# 4. Generates extension-manifest.json
# 5. Updates bundled extensions list
```

### 2.2 Extract browser-tools (14 MB dep savings)

**Current location:** `src/resources/extensions/browser-tools/` (7,000 LOC, 32 files)
**Target package:** `@gsd/ext-browser-tools`
**Dependencies to move:** `playwright` (14 MB)

**Steps:**
1. Create `packages/extensions/browser-tools/` or external repo
2. Move all 32 files from `src/resources/extensions/browser-tools/`
3. Create `package.json` with `playwright` as dependency
4. Create/update `extension-manifest.json`
5. Remove `playwright` from root `package.json` dependencies
6. Remove `browser-tools/` from `src/resources/extensions/`
7. Update `pruneRemovedBundledExtensions()` in resource-loader.ts if needed
8. Test: extension installs and functions correctly
9. Publish to npm

**Verification:**
- `gsd extensions install @gsd/ext-browser-tools` works
- All browser tools function (screenshot, navigate, click, etc.)
- Fresh install without browser-tools doesn't pull playwright
- `npm ls playwright` shows it's only in the extension's deps

### 2.3 Extract mac-tools (86 MB dep savings)

**Current location:** `src/resources/extensions/mac-tools/` (852 LOC, 1 file)
**Target package:** `@gsd/ext-mac-tools`
**Dependencies to move:** `koffi` (86 MB)

**Steps:** Same pattern as 2.2
- Move `index.ts` to package
- Move `koffi` to extension's dependencies
- Platform-specific: only installable on macOS

### 2.4 Extract context7

**Current location:** `src/resources/extensions/context7/` (435 LOC, 1 file)
**Target package:** `@gsd/ext-context7`
**Dependencies:** None beyond core

### 2.5 Extract google-search

**Current location:** `src/resources/extensions/google-search/` (473 LOC, 1 file)
**Target package:** `@gsd/ext-google-search`
**Dependencies:** `@google/genai` (shared with pi-ai — needs to be a peerDep)

**Note:** `@google/genai` is also used by `packages/pi-ai/src/providers/google*.ts`. This extension should declare it as a `peerDependency` since GSD core already provides it. If lazy-loading providers (Phase 6), this needs to be revisited.

### 2.6 Extract claude-code-cli

**Current location:** `src/resources/extensions/claude-code-cli/` (881 LOC, 8 files)
**Target package:** `@gsd/ext-claude-code-cli`
**Dependencies:** `@anthropic-ai/claude-agent-sdk` (already optional)

### 2.7 Extract aws-auth

**Current location:** `src/resources/extensions/aws-auth/` (144 LOC, 1 file)
**Target package:** `@gsd/ext-aws-auth`
**Dependencies:** None

### 2.8 Extract universal-config

**Current location:** `src/resources/extensions/universal-config/` (1,252 LOC, 9 files)
**Target package:** `@gsd/ext-universal-config`
**Dependencies:** None

### 2.9 Extract mcp-client

**Current location:** `src/resources/extensions/mcp-client/` (500 LOC, 1 file)
**Target package:** `@gsd/ext-mcp-client`
**Dependencies:** `@modelcontextprotocol/sdk` (peerDep — already in core)

### 2.10 Update Default Install Experience

After extraction:
1. Update onboarding wizard to suggest popular extensions
2. Add "recommended extensions" list in help text
3. Consider a `gsd extensions install --recommended` shortcut
4. Update CONTRIBUTING.md with extension development docs

**Overall Phase 2 Verification:**
- Fresh install: `node_modules` is ~100 MB lighter (no playwright, no koffi)
- `gsd extensions list` shows 8 fewer bundled extensions
- All 8 extracted extensions installable via `gsd extensions install`
- Core GSD workflow (discuss→plan→execute→verify) works without any extracted extensions
- Build time should decrease (fewer files to copy)

---

<a id="phase-3"></a>
## Phase 3: Preferences Service & Tier 2 Extraction

**Goal:** Formalize GSD preferences as an ExtensionAPI service, then extract 6 more extensions.
**Effort:** Medium-Large (3-4 sessions)
**Risk:** Medium (requires API changes)
**Dependencies:** Phase 0 (architecture fixes), Phase 1 (install infrastructure)

### 3.1 Create Preferences Service on ExtensionAPI

**Problem:** 5+ extensions import `gsd/preferences.js` by file path. This is the #1 coupling bottleneck.

**Solution:** Add a `preferences` service to ExtensionAPI that extensions can query.

**Files:**
- `packages/pi-coding-agent/src/core/extensions/types.ts` — extend `ExtensionAPI` interface:

```typescript
interface ExtensionAPI {
  // ... existing methods ...

  /** Access to GSD preferences (read-only for non-core extensions) */
  preferences: {
    /** Get a preference value by key path (e.g., "search.provider") */
    get<T>(key: string, defaultValue?: T): T | undefined;
    /** Get all preferences */
    getAll(): Record<string, unknown>;
    /** Subscribe to preference changes */
    onChange(key: string, handler: (value: unknown) => void): () => void;
  };

  /** Access to shared utilities */
  utils: {
    /** Debug logging (replaces direct import of gsd/debug-logger) */
    debug: {
      log(...args: unknown[]): void;
      time(label: string): void;
      count(label: string): void;
      peak(label: string, value: number): void;
    };
    /** Path utilities (replaces direct import of gsd/paths) */
    paths: {
      gsdRoot(cwd?: string): string;
      planningDir(cwd?: string): string;
    };
  };
}
```

- `packages/pi-coding-agent/src/core/extensions/loader.ts` — populate preferences and utils services when creating ExtensionAPI instances
- `src/resources/extensions/gsd/index.ts` — register preferences provider via hook

**Key design decisions:**
- Preferences are **read-only** for non-core extensions (prevents conflicts)
- Core extension registers the preferences provider at `session_start`
- Other extensions receive resolved preferences via the API
- Typing uses generics for type safety

### 3.2 Create Shared Utilities Service

In addition to preferences, extract these commonly-imported utilities into the ExtensionAPI `utils`:

| Current Import | New API | Used By |
|---------------|---------|---------|
| `gsd/debug-logger.js` | `pi.utils.debug.log()` | github-sync, ttsr |
| `gsd/paths.js` | `pi.utils.paths.gsdRoot()` | github-sync, shared |
| `shared/rtk.js` | `pi.utils.rtk.rewrite()` | bg-shell, async-jobs |
| `shared/tui.js` | `pi.ui.interview()` | slash-commands |
| `shared/frontmatter.js` | `pi.utils.parseFrontmatter()` | ttsr |

### 3.3 Extract search-the-web

**Current coupling:** 1 import from `gsd/preferences.js`
**Fix:** Replace with `pi.preferences.get("search.provider")`
**Target package:** `@gsd/ext-search-the-web`

### 3.4 Extract subagent

**Current coupling:** 1 import from `gsd/preferences.js`
**Fix:** Replace with `pi.preferences.get("parallel.*")`
**Target package:** `@gsd/ext-subagent`

**Special consideration:** The subagent extension provides the core `subagent` tool. This is used by many GSD features. Consider keeping this bundled but decoupled, or making it auto-installed.

### 3.5 Extract voice

**Current coupling:** 1 import from `shared/mod.js`
**Fix:** Bundle needed util or use `pi.utils`
**Target package:** `@gsd/ext-voice`

### 3.6 Extract async-jobs

**Current coupling:** 1 import from `shared/rtk.js`
**Fix:** Use `pi.utils.rtk` or inline the needed function
**Target package:** `@gsd/ext-async-jobs`

### 3.7 Extract remote-questions

**Current coupling:** `gsd/preferences.js` + `shared/`
**Fix:** Use `pi.preferences` + `pi.utils`
**Target package:** `@gsd/ext-remote-questions`

### 3.8 Extract slash-commands

**Current coupling:** 1 import from `shared/tui.js`
**Fix:** Use `pi.ui.interview()` or bundle TUI helper
**Target package:** `@gsd/ext-slash-commands`

### 3.9 Deprecation Notices

For each extracted extension:
1. Keep a stub in `src/resources/extensions/<name>/` that:
   - Detects the extension is not installed
   - Shows a one-time notice: "browser-tools has moved to an installable extension. Run: gsd extensions install browser-tools"
   - Auto-suggests install on first use of any tool that requires it
2. Remove stubs after 2 major versions

**Verification:**
- ExtensionAPI preferences service works for all consumers
- 6 more extensions extracted and installable
- No direct file-path imports from `gsd/` in any non-core extension
- Core workflow still works without Tier 2 extensions

---

<a id="phase-4"></a>
## Phase 4: Skills & Agents as Installable Packs

**Goal:** Move 18 skills and 2 agents to installable packs via `npx skills add`.
**Effort:** Small-Medium (1-2 sessions)
**Risk:** Low (skills are pure markdown content)
**Dependencies:** None (skills system already supports external installation)

### 4.1 Create Skill Pack Repositories

Skills are already loaded from `~/.agents/skills/` via the existing skills ecosystem. Create skill pack repositories:

| Pack | Skills | Lines | Repository |
|------|--------|-------|------------|
| `@gsd/skills-web-design` | accessibility, best-practices, core-web-vitals, frontend-design, make-interfaces-feel-better, react-best-practices, userinterface-wiki, web-design-guidelines, web-quality-audit | 11,062 | `gsd-build/skills-web-design` |
| `@gsd/skills-meta` | create-gsd-extension, create-skill, create-workflow | 8,804 | `gsd-build/skills-meta` |
| `@gsd/skills-debug` | debug-like-expert, code-optimizer | 3,302 | `gsd-build/skills-debug` |
| `@gsd/skills-integration` | agent-browser, github-workflows | 3,166 | `gsd-build/skills-integration` |

### 4.2 Create Agent Pack Repository

| Pack | Agents | Lines | Repository |
|------|--------|-------|------------|
| `@gsd/agents-language` | javascript-pro, typescript-pro | 535 | `gsd-build/agents-language` |

### 4.3 Move Skills Out of Bundled Resources

For each skill pack:
1. Create GitHub repository with pack structure
2. Move skill directories from `src/resources/skills/`
3. Add `SKILL-PACK.json` manifest (name, version, skills list)
4. Publish to npm / skills registry
5. Update `src/resources/skills/` to only contain core skills: `lint`, `review`, `test`

### 4.4 Update Onboarding to Suggest Skill Packs

**File:** `src/onboarding.ts`

Add a step in the setup wizard:
```
Would you like to install recommended skill packs?
  [x] Web Design & Accessibility (9 skills)
  [x] Debugging & Optimization (2 skills)
  [ ] Meta Skills (extension/skill creation)
  [ ] Integration (browser, GitHub)
  [ ] Language Specialists (JS/TS agents)
```

### 4.5 Add `gsd skills` Command

Alias for `npx skills` with GSD-specific additions:
- `gsd skills list` — show installed skills with source
- `gsd skills install <pack>` — install skill pack
- `gsd skills search <query>` — search available skills

**Verification:**
- `npx skills add gsd-build/skills-web-design` installs all 9 web design skills
- Skills function identically after extraction
- Fresh install ships with only lint, review, test skills
- Onboarding wizard offers skill pack installation

---

<a id="phase-5"></a>
## Phase 5: GSD Core Decomposition

**Goal:** Break the 177K LOC `gsd` extension monolith into focused sub-extensions.
**Effort:** Large (4-6 sessions)
**Risk:** High (deep coupling, most complex phase)
**Dependencies:** Phase 0, Phase 3 (preferences service)

### 5.1 Create @gsd/extension-sdk Package

**Purpose:** A lightweight package that provides shared utilities for GSD sub-extensions, replacing direct file-path imports.

**Location:** `packages/extension-sdk/`

**Exports:**
```typescript
// @gsd/extension-sdk
export { gsdRoot, planningDir, projectRoot } from './paths'
export { debugLog, debugTime, debugCount, debugPeak } from './debug-logger'
export { atomicWriteSync } from './atomic-write'
export { loadFile, parseSummary, clearParseCache } from './files'
export { parseRoadmap, parsePlan } from './parsers'
export type { GSDState, Phase, Milestone, Slice, Task } from './types'
export type { GSDPreferences, RemoteQuestionsConfig } from './preferences-types'
```

**Files to create:**
- `packages/extension-sdk/package.json`
- `packages/extension-sdk/src/` — extracted from `src/resources/extensions/gsd/`
- `packages/extension-sdk/tsconfig.json`

**Migration:**
- `github-sync` rewrites its 6 imports to use `@gsd/extension-sdk`
- `cmux` rewrites imports to use `@gsd/extension-sdk` types
- `ttsr` rewrites debug-logger import
- `shared/rtk-session-stats.ts` rewrites path import

### 5.2 Extract Parallel Orchestrator Extension

**Current files:** `parallel-orchestrator.ts`, `parallel-monitor-overlay.ts`, `parallel-merge.ts`, `commands/handlers/parallel.ts`, `auto/reactive-*.ts`
**Target:** `@gsd/ext-parallel`
**Coupling:** worktree management, auto-mode dispatch
**Size:** ~3,000+ LOC

**Steps:**
1. Identify all parallel-related files via grep for `parallel` imports
2. Define event-based contract between core auto-mode and parallel extension
3. Core auto-mode emits: `dispatch:parallel_available`, `task:parallel_candidate`
4. Parallel extension subscribes and handles orchestration
5. Move files to `src/resources/extensions/gsd-parallel/` (bundled but optional)
6. Register parallel commands via `pi.registerCommand()`
7. Update auto-mode to check for parallel extension availability before dispatching

### 5.3 Extract Watch/Dashboard TUIs

**Current files:** `watch/`, `dashboard-overlay.ts`, `visualizer-overlay.ts`, `visualizer-views.ts`, `visualizer-data.ts`, `auto-dashboard.ts`
**Target:** `@gsd/ext-watch`
**Coupling:** state (read-only), preferences
**Size:** ~2,000+ LOC

**Steps:**
1. Watch/dashboard/visualizer are read-only consumers of GSD state
2. Move to separate extension that subscribes to state change events
3. Core emits `state:changed` events with serialized state
4. Dashboard extension renders based on received state
5. Register `/gsd watch`, `/gsd status`, `/gsd visualize` commands

### 5.4 Extract Doctor System

**Current files:** `doctor.ts`, `doctor-checks.ts`, `doctor-providers.ts`, `doctor-git-checks.ts`, `doctor-engine-checks.ts`, `commands-inspect.ts`
**Target:** `@gsd/ext-doctor`
**Coupling:** preferences, state, paths
**Size:** ~2,000+ LOC

**Steps:**
1. Doctor is a diagnostic tool — reads state but doesn't modify workflow
2. Move to separate extension with `@gsd/extension-sdk` imports
3. Register `/gsd doctor`, `/gsd inspect` commands
4. Keep basic health checks in core (are .gsd/ files readable?)

### 5.5 Extract Forensics

**Current files:** `session-forensics.ts`, `prompts/forensics.md`
**Target:** `@gsd/ext-forensics`
**Coupling:** logs, state (read-only)
**Size:** ~500+ LOC

### 5.6 Extract Workflow Templates

**Current files:** `workflow-engine.ts`, `workflow-events.ts`, `workflow-logger.ts`, `workflow-manifest.ts`, `workflow-migration.ts`, `workflow-projections.ts`, `workflow-reconcile.ts`, `workflow-templates.ts`, `workflow-templates/`, `commands-workflow-templates.ts`, `custom-workflow-engine.ts`
**Target:** `@gsd/ext-workflows`
**Coupling:** auto-mode (registers as dispatch target), preferences
**Size:** ~2,000+ LOC

### 5.7 Extract Marketplace/Plugin Import

**Current files:** `marketplace-discovery.ts`, `plugin-importer.ts`, `namespaced-registry.ts`, `claude-import.ts`, `collision-diagnostics.ts`
**Target:** `@gsd/ext-marketplace`
**Coupling:** registry, skill discovery
**Size:** ~1,500+ LOC

### 5.8 Extract GitHub Sync

**Current location:** `src/resources/extensions/github-sync/` (1,325 LOC, 10 files)
**Target:** `@gsd/ext-github-sync`
**Current coupling:** 6 imports from gsd internals
**Fix:** Rewrite all imports to use `@gsd/extension-sdk`

**This is the most coupled non-core extension.** After `@gsd/extension-sdk` exists (5.1), rewrite:
- `gsd/preferences.js` → `@gsd/extension-sdk` or `pi.preferences`
- `gsd/paths.js` → `@gsd/extension-sdk`
- `gsd/debug-logger.js` → `@gsd/extension-sdk`
- `gsd/files.js` → `@gsd/extension-sdk`
- `gsd/parsers-legacy.js` → `@gsd/extension-sdk`
- `gsd/atomic-write.js` → `@gsd/extension-sdk`

### 5.9 Verify Core Is Minimal

After all sub-extensions are extracted, the core `gsd` extension should contain only:

```
src/resources/extensions/gsd/
├── auto.ts                    # Core auto-mode loop
├── auto-dispatch.ts           # Phase dispatch
├── auto-prompts.ts            # Prompt template loading
├── auto-start.ts              # Auto-mode startup
├── auto-loop.ts               # Main execution loop
├── auto-recovery.ts           # Error recovery
├── auto-post-unit.ts          # Post-unit processing
├── auto-unit-closeout.ts      # Unit completion
├── auto-utils.ts              # Auto-mode utilities
├── auto-verification.ts       # Verification step
├── auto-model-selection.ts    # Model selection for phases
├── auto-budget.ts             # Budget management
├── auto-timeout-recovery.ts   # Timeout handling
├── auto-worktree.ts           # Worktree integration (may stay core)
├── state.ts                   # State derivation from .gsd/ files
├── types.ts                   # Core types
├── preferences.ts             # Preferences loading
├── preferences-types.ts       # Preference type definitions
├── preferences-validation.ts  # Preference validation
├── preferences-models.ts      # Model preferences
├── preferences-skills.ts      # Skill preferences
├── paths.ts                   # Path resolution
├── db-writer.ts               # SQLite state persistence
├── gsd-db.ts                  # Database schema
├── definition-loader.ts       # Milestone/slice file parsing
├── validation.ts              # File validation
├── constants.ts               # Constants
├── commands/                  # Core commands only
│   ├── catalog.ts             # Command registry (trimmed)
│   └── handlers/
│       ├── auto.ts            # auto/next/stop/pause
│       └── workflow.ts        # discuss/queue/new-milestone (core only)
├── prompts/                   # Core prompts only (19)
├── index.ts                   # Extension entry point (trimmed)
└── commands.ts                # Command dispatcher (trimmed)
```

**Target:** ~15,000-20,000 LOC (down from 177K)

**Verification:**
- Core GSD workflow (init→discuss→plan→execute→verify) works with ONLY core extension
- Each sub-extension installs and functions independently
- No circular dependencies between sub-extensions
- Build time reduced significantly

---

<a id="phase-6"></a>
## Phase 6: AI Provider SDK Lazy Loading

**Goal:** Lazy-load AI provider SDKs so only the active provider's SDK is imported at runtime.
**Effort:** Medium (2-3 sessions)
**Risk:** Medium (touches hot path)
**Dependencies:** None (independent of other phases)

### 6.1 Audit Current Provider Loading

**Location:** `packages/pi-ai/src/providers/`

| Provider | File | SDK Import | Size |
|---------|------|------------|------|
| Anthropic | `anthropic.ts` | `@anthropic-ai/sdk` | 5 MB |
| Anthropic Vertex | `anthropic-vertex.ts` | `@anthropic-ai/vertex-sdk` | 2 MB |
| Google | `google.ts` + variants | `@google/genai` | 13 MB |
| Mistral | `mistral.ts` | `@mistralai/mistralai` | 11 MB |
| OpenAI-compatible | via pi-ai | `openai` | 13 MB |
| Bedrock | `amazon-bedrock.ts` | `@aws-sdk/client-bedrock-runtime` | 1 MB |

### 6.2 Implement Lazy Provider Loading

**Pattern:** Already exists for `proxy-agent` in bedrock provider.

For each provider file:
1. Replace top-level `import { Anthropic } from '@anthropic-ai/sdk'` with:
   ```typescript
   let _sdk: typeof import('@anthropic-ai/sdk') | null = null;
   async function getSDK() {
     if (!_sdk) _sdk = await import('@anthropic-ai/sdk');
     return _sdk;
   }
   ```
2. Update all SDK usage to be async (most already are since they're in async methods)
3. Provider factory only imports the SDK for the selected provider

### 6.3 Move Non-Default Provider SDKs to Optional Dependencies

**File:** `package.json`

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "^0.73.0"  // Keep: default provider
  },
  "optionalDependencies": {
    "@google/genai": "^1.40.0",
    "@mistralai/mistralai": "^1.14.1",
    "@anthropic-ai/vertex-sdk": "^0.14.4",
    "@aws-sdk/client-bedrock-runtime": "^3.983.0"
  }
}
```

### 6.4 Graceful Missing SDK Handling

When a user selects a provider whose SDK is not installed:
1. Catch the `import()` failure
2. Display: "Google provider requires @google/genai. Install it with: npm install -g @google/genai"
3. Or auto-install: "Installing @google/genai..." (with user confirmation)

**Verification:**
- Fresh install only loads Anthropic SDK (~5 MB) unless user configures another provider
- Switching to Google provider triggers lazy load of `@google/genai`
- Missing SDK shows helpful install message
- All providers still function after lazy-loading
- No regression in API call latency (SDK loaded once, cached)

---

<a id="phase-7"></a>
## Phase 7: Barrel Import Optimization

**Goal:** Break the `@gsd/pi-coding-agent` barrel import so `cli.ts` only loads what each code path needs.
**Effort:** Large (3-5 sessions)
**Risk:** High (fundamental import architecture change)
**Dependencies:** Should be last — other phases reduce the surface area first

### 7.1 Audit Barrel Import

**File:** `packages/pi-coding-agent/src/index.ts`

Map every export and which consumers use each:
- `cli.ts` uses: `AuthStorage`, `DefaultResourceLoader`, `ModelRegistry`, `SessionManager`, `createAgentSession`, `InteractiveMode`, `runPrintMode`, `runRpcMode`, `SettingsManager`, `runPackageCommand`
- Other consumers: `headless.ts`, `web-mode.ts`, `mcp-server.ts`

### 7.2 Create Subpath Exports

**File:** `packages/pi-coding-agent/package.json`

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./auth": "./dist/auth/index.js",
    "./session": "./dist/session/index.js",
    "./resources": "./dist/resources/index.js",
    "./models": "./dist/models/index.js",
    "./interactive": "./dist/interactive/index.js",
    "./print": "./dist/print/index.js",
    "./rpc": "./dist/rpc/index.js",
    "./settings": "./dist/settings/index.js",
    "./extensions": "./dist/extensions/index.js"
  }
}
```

### 7.3 Update Consumers to Use Subpath Imports

**File:** `src/cli.ts`

Before:
```typescript
import { AuthStorage, DefaultResourceLoader, ModelRegistry, ... } from '@gsd/pi-coding-agent'
```

After:
```typescript
import { AuthStorage } from '@gsd/pi-coding-agent/auth'
import { DefaultResourceLoader } from '@gsd/pi-coding-agent/resources'
import { ModelRegistry } from '@gsd/pi-coding-agent/models'
// InteractiveMode loaded lazily:
const { InteractiveMode } = await import('@gsd/pi-coding-agent/interactive')
```

### 7.4 Defer Non-Essential Imports in cli.ts

Many top-level imports in `cli.ts` are only used in specific code paths:

| Import | Used When | Action |
|--------|-----------|--------|
| `InteractiveMode` | Interactive session | Lazy import |
| `runPrintMode` | `--print` flag | Lazy import |
| `runRpcMode` | `--mode rpc` | Lazy import |
| `onboarding` | First run only | Already could be lazy |
| `web-mode` | `gsd web` only | Lazy import |
| `update-check` | Interactive mode only | Lazy import |

### 7.5 Measure and Validate

**Benchmark:**
- Measure startup time before and after: `time gsd --version`
- Measure interactive startup: `time gsd` (to first prompt)
- Target: 50%+ reduction in cold-start time

**Verification:**
- All CLI modes still work (interactive, headless, print, rpc, mcp, web)
- Startup time measurably improved
- No import errors or missing modules
- Build passes, all tests pass

---

<a id="risk-register"></a>
## Risk Register

| Risk | Phase | Likelihood | Impact | Mitigation |
|------|-------|-----------|--------|-----------|
| Breaking existing user workflows | 2-3 | Medium | High | Deprecation stubs with install hints; keep extensions bundled for 2 versions |
| Extension dependency conflicts | 1 | Medium | Medium | Isolate extension node_modules; peerDep on core |
| Preferences API doesn't cover all use cases | 3 | Medium | Medium | Design API based on actual usage patterns from grep analysis |
| GSD core decomposition creates regressions | 5 | High | High | Extensive integration tests; decompose one sub-extension at a time |
| Provider lazy-loading breaks fast path | 6 | Low | Medium | Cache loaded SDK; benchmark critical path |
| Barrel import changes break third-party extensions | 7 | Low | Medium | Keep barrel export as backward-compat facade; add subpath exports alongside |
| npm publish/install adds friction for users | 1-2 | Medium | Medium | Auto-suggest installs; provide `--recommended` bundle install |

---

<a id="success-metrics"></a>
## Success Metrics

| Metric | Current | Phase 2 Target | Phase 5 Target | Phase 7 Target |
|--------|---------|---------------|---------------|---------------|
| Core extension LOC | 177,000 | 177,000 | 15,000-20,000 | 15,000-20,000 |
| Bundled extensions | 20 | 12 | 5 | 5 |
| Bundled skills | 19 | 19 | 3 | 3 |
| `node_modules` size | 842 MB | ~742 MB | ~600 MB | ~450 MB |
| Extensions loaded on startup | 20 | 12 | 5 | 5 |
| Cold startup time (`gsd --version`) | ~1.5s | ~1.3s | ~0.8s | ~0.4s |
| Time to first prompt (interactive) | ~3s | ~2.5s | ~1.5s | ~1s |

---

## Implementation Timeline (Suggested)

| Phase | Depends On | Can Parallel With | Est. Sessions |
|-------|-----------|-------------------|---------------|
| Phase 0 | — | Phase 1 | 1-2 |
| Phase 1 | — | Phase 0, Phase 4 | 2-3 |
| Phase 2 | Phase 1 | Phase 4 | 2-3 |
| Phase 3 | Phase 0, Phase 1 | Phase 4 | 3-4 |
| Phase 4 | — | Anything | 1-2 |
| Phase 5 | Phase 0, Phase 3 | Phase 6 | 4-6 |
| Phase 6 | — | Phase 5 | 2-3 |
| Phase 7 | All others | — | 3-5 |

**Critical path:** Phase 0 → Phase 3 → Phase 5 → Phase 7
**Quick wins:** Phase 0 + Phase 4 can start immediately
**Biggest impact:** Phase 2 (100 MB saved) + Phase 5 (core LOC reduction)
