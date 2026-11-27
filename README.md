# transcoda/.github

Shared checks and dev config for the repositories in the transcoda organization, so each rule has
one definition:

- [GitHub Actions](#actions), used as `transcoda/.github/actions/<name>@<sha> # <tag>`;
- [`@transcoda/dev-config`](#the-dev-config-package), a dev dependency installed from this
  repository by git tag: the Biome and TypeScript bases, the `.changes/` release-note format, and
  the file-size budget as a command.

Both come from the same tag. Callers pin actions by commit SHA with the tag in a comment, and the
package by tag (the lockfile pins its commit); Renovate updates both.

## Actions

The scripts behind the actions are plain JavaScript without dependencies. Most run on the runner's
own `node` (any version from 20 up); `release-note` sets up Node from the caller's `.node-version`.

### `actions/pr-title`

Fails when a pull request title doesn't follow the house style:

```
<Area>: <what changed>
```

The area names the part of the project and starts with a capital letter or a digit:
`Plugins: update check and update count in the menu`, `CI: OpenSSF Scorecard`,
`Radarr, Sonarr: say which path was unknown`. No conventional-commit prefixes
(`feat:`, `chore(deps):`), no `(scope)`, no full stop at the end. Squash merges use the
title as the commit message, so this keeps `main`'s history in the same style.

```yaml
name: PR title

on:
  pull_request:
    types: [opened, edited, reopened, synchronize]

permissions:
  contents: read

jobs:
  pr-title:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - uses: transcoda/.github/actions/pr-title@<sha> # v1.1.0
```

### `actions/release-note`

Checks out the pull request and fails unless it adds or changes a valid release note in
`.changes/` (see [the format](#the-changes-release-note-format)), or carries the
`no user-facing change` label.

| Input | Default | |
| --- | --- | --- |
| `layout` | `''` | `flat` or `per-folder`: the shared checker. Empty runs the repository's own `script` (the v1.0.0 behaviour, deprecated; it goes once both repositories use `layout`). |
| `folders` | `''` | With `per-folder`: the directory whose subdirectories are the note folders. |
| `skip-authors` | `''` | Comma-separated logins whose pull requests need no note. |
| `script` | `scripts/check-release-note.mjs` | Without `layout` only: run as `node <script> <base-sha> <head-sha> <labels-json> <author-login>`. |

```yaml
name: Release note

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read

jobs:
  release-note:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      # core: notes directly in .changes/
      - uses: transcoda/.github/actions/release-note@<sha> # v1.1.0
        with:
          layout: flat
```

```yaml
      # plugins: a folder per plugin, and Renovate's pull requests need no note
      - uses: transcoda/.github/actions/release-note@<sha> # v1.1.0
        with:
          layout: per-folder
          folders: plugins
          skip-authors: renovate[bot]
```

The same check runs locally as `transcoda-release-note check` from the
[package](#the-changes-release-note-format).

### `actions/nightly-issues`

Turns a nightly run's test reports into issues: one per failing test, a comment while it keeps
failing, closed when it passes again. A run that failed outside its tests (install, build, a check
script) gets one "the run failed outside its tests" issue; more than ten new failures at once get
one "many tests fail" issue listing them. Issues are found again by a hidden
`<!-- nightly-test: <test id> -->` line, the same one core's `scripts/nightly-issues.ts` wrote, so
the issues it opened carry on.

| Input | Default | |
| --- | --- | --- |
| `reports` | required | JSON reports, one path per line: vitest's (`--reporter=json`) or Playwright's, told apart by their shape. A missing file means "nothing ran there": its tests' issues stay open and the run counts as failed. |
| `run-failed` | `'false'` | `'true'` when a test job did not succeed. |
| `step-failed` | `'false'` | `'true'` when a step that is not a test failed (typecheck, lint, bundle): opens the run issue even when tests fail too. |
| `test-root` | `${{ github.workspace }}` | Where the tests ran; vitest's absolute paths are made relative to it for the test ids. |
| `label` | `nightly` | The label the issues get and are found by. |
| `token` | `${{ github.token }}` | Needs `issues: write`. |

Set `DRY_RUN: 'true'` in the step's `env` to only print what it would do.

```yaml
  issues:
    needs: [changed, unit, e2e]
    if: ${{ !cancelled() && needs.changed.outputs.run == 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      issues: write
    steps:
      - uses: actions/download-artifact@<sha> # v8.0.2
        with:
          pattern: nightly-*
          path: .local/artifacts
      - uses: transcoda/.github/actions/nightly-issues@<sha> # v1.1.0
        with:
          reports: |
            .local/artifacts/nightly-unit/vitest.json
            .local/artifacts/nightly-e2e/nightly/playwright.json
          run-failed: ${{ needs.unit.result != 'success' || needs.e2e.result != 'success' }}
          # The tests ran in the container's copy of the repository.
          test-root: /work/repo
```

The job needs no checkout and no `setup-node`. In the plugins repository, `step-failed` takes the
check job's output (`${{ needs.check.outputs.step-failed == 'true' }}`), and `test-root` stays at
its default, the check job's checkout.

### `actions/nightly-changed`

Says whether a scheduled workflow has anything new to test. Output `run` is `'true'` when this
repository's branch moved since the workflow's last completed run on it (any outcome: a failure on
the same commit would only fail again), when the `main` of a watched repository got a commit since
that run started, when there is no earlier run, or when the run was started by hand
(`workflow_dispatch`). Otherwise `'false'`. The workflow is found from the run itself
(`GITHUB_WORKFLOW_REF`), so it works under any file name.

| Input | Default | |
| --- | --- | --- |
| `also-watch` | `''` | Other repositories, `owner/name`, one per line, whose `main` moving also counts. |
| `token` | `${{ github.token }}` | Needs `actions: read` here, and read access to the watched repositories (public ones need nothing more). |

```yaml
jobs:
  changed:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      actions: read
    outputs:
      run: ${{ steps.changed.outputs.run }}
    steps:
      - id: changed
        uses: transcoda/.github/actions/nightly-changed@<sha> # v1.1.0
        with:
          also-watch: transcoda/transcoda # plugins only; core leaves `with` out

  unit:
    needs: changed
    if: needs.changed.outputs.run == 'true'
```

### `actions/main-red`

Opens one issue (label `main-red`) when a push run of a workflow on the default branch fails,
naming the workflow and the run; comments on it for every further failing run, and closes it when
that workflow passes on the default branch again. Timed-out runs and runs that failed to start
count as failures; cancelled and skipped runs change nothing. Each workflow has its own issue,
found again by a hidden `<!-- main-red: .github/workflows/<file> -->` line. Pull request runs and
other branches are ignored, so it can watch workflows that also run on pull requests.

| Input | Default | |
| --- | --- | --- |
| `label` | `main-red` | The label the issues get and are found by. |
| `token` | `${{ github.token }}` | Needs `issues: write`. |

Add it as its own workflow, started when the watched workflows complete. GitHub reads
`workflow_run` workflows from the default branch only, so it starts working once merged:

```yaml
name: Main red

on:
  workflow_run:
    workflows: [CI, Docker] # the `name:` of each workflow to watch
    types: [completed]
    branches: [main]

permissions:
  contents: read

jobs:
  alert:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    permissions:
      issues: write
    steps:
      - uses: transcoda/.github/actions/main-red@<sha> # v1.1.0
```

### `actions/file-size`

Fails when a file matching the globs has more lines than the budget. Files that are already over
it go in an allowlist with their current line count, which may only shrink: a listed file that
grows past its number fails; one that shrank fails until its number is lowered to match; one that
fits the budget again fails until it is removed; an entry for a file that is gone fails. Files are
the ones git knows: tracked, plus new files that are not ignored. Lines are counted as an editor
shows them (a final newline does not add one).

| Input | Default | |
| --- | --- | --- |
| `globs` | required | Files to check, one glob per line, relative to the repository root. `**` spans directories, `*` and `?` stay within one, `{a,b}` is either; a line starting with `!` excludes; `#` lines are comments. |
| `max-lines` | required | The most lines a file may have. |
| `allowlist` | `''` | A JSON file `{ "path": lines }` of the files over the budget. |

```yaml
    steps:
      - uses: actions/checkout@<sha> # v7.0.1
      - uses: transcoda/.github/actions/file-size@<sha> # v1.1.0
        with:
          max-lines: 1200
          allowlist: .github/file-size-allowlist.json
          globs: |
            apps/**/*.{ts,tsx,css}
            packages/**/*.ts
            !**/fixtures/**
```

```json
{
  "apps/server/src/engine/pipeline.ts": 3095,
  "apps/web/src/styles.css": 11620
}
```

The same check runs locally (for `pnpm check`) as the package's `transcoda-file-size` command, in
the repository root:

```sh
transcoda-file-size --max-lines 1200 --allowlist .github/file-size-allowlist.json \
  'apps/**/*.{ts,tsx,css}' 'packages/**/*.ts' '!**/fixtures/**'
```

It exits 0 when every file fits, 1 with one line per problem (a `::error file=…::` annotation on
Actions), 2 for bad arguments or a bad allowlist.

### `actions/screenshots`

Fails a pull request that changes files matching the globs (the UI) when its description shows no
image: a Markdown image `![…](…)`, an `<img>` or `<video>` with a `src`, or a GitHub attachment
link (`https://github.com/user-attachments/assets/…`, which is how an uploaded recording appears).
Anything inside an HTML comment does not count, so a template's commented-out example is not a
screenshot. A renamed file counts by its old and its new path. A label skips the check.

| Input | Default | |
| --- | --- | --- |
| `paths` | required | The UI files, one glob per line (the same syntax as `file-size`); `!` lines exclude tests and fixtures. |
| `skip-label` | `no screenshots needed` | The label that says nothing visible changed. |
| `token` | `${{ github.token }}` | Needs `pull-requests: read` to list the changed files. |

```yaml
name: Screenshots

on:
  pull_request:
    types: [opened, edited, reopened, synchronize, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: read

jobs:
  screenshots:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - uses: transcoda/.github/actions/screenshots@<sha> # v1.1.0
        with:
          paths: |
            apps/web/src/**
            !**/*.test.{ts,tsx}
            !apps/web/src/test/**
```

`edited` runs the check again when screenshots are added to the description; `labeled` and
`unlabeled` when the label changes. Create the label in the repository first.

## The dev config package

`@transcoda/dev-config` is this repository, installed as a git dependency (it is not on npm):

```json
{
  "devDependencies": {
    "@transcoda/dev-config": "github:transcoda/.github#v1.1.0"
  }
}
```

`pnpm install` resolves the tag to its commit and pins that, with an integrity hash, in
`pnpm-lock.yaml` (a `codeload.github.com` tarball), so `--frozen-lockfile` installs exactly that
commit. The package has no dependencies and no install scripts, so blocked builds (`allowBuilds`)
don't touch it, and `minimumReleaseAge` (which applies to registry packages) doesn't hold it back.
Renovate's npm manager reads the `github:` reference as a `github-tags` dependency and moves it to
the next tag, lockfile included.

### Biome

`biome/base.json` holds what both repositories share: the formatter (spaces, 100 columns, single
quotes; Markdown and YAML unformatted), the recommended rules with organised imports, and these as
errors everywhere: `useImportExtensions`, `noFloatingPromises`, `useAwaitThenable`,
`noDefaultExport`, `noNonNullAssertion`, `useConsistentArrayType`, `useConsistentTestIt`,
`useTestHooksOnTop`, `noDeprecatedImports`, `noExplicitAny`, `noFocusedTests`, `noImportCycles`,
`noSkippedTests`. `noConsole` is an error in every `src/` directory (`**/src/**`).
`noDefaultExport` is off for config files (`**/*.config.{ts,mts,js,mjs}`).

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "extends": ["@transcoda/dev-config/biome"],
  "files": { "includes": ["**", "!**/dist", "!**/node_modules", "!pnpm-lock.yaml"] }
}
```

A repository adds its own `files`, and its exceptions and layout-specific rules as `overrides`,
which apply after the base's. For the plugins repository, whose plugin entry points default-export
the plugin:

```json
  "overrides": [
    {
      "includes": ["plugins/*/src/index.ts"],
      "linter": { "rules": { "style": { "noDefaultExport": "off" } } }
    }
  ]
```

The two Grit rules ship with the package; a repository turns them on for its own paths (the path
is relative to its `biome.json`):

- `biome/utc-dates.grit`: no local-time `Date` methods (`getHours`, `toLocaleDateString`, …) in
  code that keeps time in UTC.
- `biome/test-cleanup.grit`: a test file that renders with Testing Library needs a top-level
  `afterEach(cleanup)`.

```json
  "plugins": [
    {
      "path": "./node_modules/@transcoda/dev-config/biome/utc-dates.grit",
      "includes": ["apps/server/src/**", "packages/*/src/**", "!**/*.test.ts"]
    },
    {
      "path": "./node_modules/@transcoda/dev-config/biome/test-cleanup.grit",
      "includes": ["apps/web/src/**/*.test.tsx", "apps/web/src/**/*.test.ts"]
    }
  ]
```

The base is tested against the Biome version this repository pins (`biome/base.test.mjs`); keep
it the same as the other repositories'.

### TypeScript

`tsconfig/base.json` is the strict base both repositories had as identical copies
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ES2024,
NodeNext):

```json
{
  "extends": "@transcoda/dev-config/tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"]
}
```

### The `.changes/` release-note format

`changes/notes.mjs` (import `@transcoda/dev-config/changes`) is the one definition of a release
note: a Markdown file in `.changes/` with front matter `type: breaking|new|improved|fixed`, then
one or two sentences for people who use the software, without commit hashes or pull request
numbers. A `README.md` at any depth is not a note, nor is `.changes/highlights.md`.

Two layouts:

- **flat** (core): `.changes/<short-name>.md`, directly in `.changes/`.
- **per folder** (plugins): `.changes/<folder>/<short-name>.md`, or the flat
  `.changes/<folder>-<short-name>.md`, where `<folder>` is a directory under one directory of the
  repository (`plugins/`). A flat name belongs to the longest folder name it starts with.

The command `transcoda-release-note` (the package's bin; the release-note action runs it too), in
the repository root:

```sh
transcoda-release-note lint                          # core's pnpm check: every note is valid
transcoda-release-note lint --per-folder plugins     # plugins' pnpm check
transcoda-release-note check <base-sha> <head-sha> <labels-json> [<author>] \
  [--per-folder <dir>] [--skip-authors renovate[bot]]
```

It exits 0 when fine, 1 with one line per problem, 2 for bad arguments.

The library, for the release scripts that stay in each repository (versions, changelog files and
highlights differ):

| Export | |
| --- | --- |
| `TYPES`, `HEADINGS`, `NO_NOTE_LABEL`, `HIGHLIGHTS`, `DIR` | `['breaking', 'new', 'improved', 'fixed']` (heading order), their headings, the label, `'highlights.md'`, `'.changes'`. |
| `layoutOf(root, perFolder?)` | The flat layout, or the per-folder one read from `root/<perFolder>`. |
| `parseNote(text)` | `{ type, text }` with the lines joined, or `{ errors }`. |
| `textErrors(text)`, `noteErrors(path, text, layout)` | A note's problems: format, hashes and PR numbers; plus its place. |
| `isNote(path)`, `folderOf(path, layout)`, `listNotes(root)` | Which paths are notes, a note's folder, every note path. |
| `lintNotes(root, layout)` | Every note's problems. |
| `checkPullRequest({ changed, labels, author, skipAuthors, layout, read })` | The pull request rule, as `{ ok, messages }`. |
| `readNotes(root, layout, folder?)` | `{ notes: [{ path, type, text }], errors }`: every note, or one folder's (other folders' notes are not read). |
| `groupEntries(notes)`, `renderGroups(entries, level)` | Entries in heading order, and Markdown with `level` headings. |

```js
import { groupEntries, layoutOf, readNotes, renderGroups } from '@transcoda/dev-config/changes';

// The plugins release body for one plugin.
const root = process.cwd();
const { notes, errors } = readNotes(root, layoutOf(root, 'plugins'), 'sonarr');
process.stdout.write(renderGroups(groupEntries(notes), 3));
```

## Development

```sh
pnpm install
pnpm check   # Biome with this repository's own base config, then every test (node --test)
```

Tests sit next to the code as `*.test.mjs` and use `node:test`. The code is plain `.mjs` with JSDoc
types: Node does not strip types from files under `node_modules`, so the package can't ship `.ts`,
and the actions run on the runner's Node without a build.

To release: set `version` in `package.json`, merge, tag `vX.Y.Z` on `main`, then let Renovate
update the callers.
