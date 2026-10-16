# transcoda/.github

Shared GitHub Actions for the repositories in the transcoda organization.

## Actions

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
      - uses: transcoda/.github/actions/pr-title@<sha> # v1.0.0
```

### `actions/release-note`

Checks out the pull request, sets up Node from `.node-version` and runs the repository's own
release-note checker as `node <script> <base-sha> <head-sha> <labels-json> <author-login>`.
The rules stay in each repository, because they differ (the plugins repository files notes per
plugin and lets Renovate pull requests skip them).

```yaml
jobs:
  release-note:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: transcoda/.github/actions/release-note@<sha> # v1.0.0
        with:
          script: scripts/check-release-note.mjs # the default
```

Callers pin the actions by commit SHA with the tag in a comment; Renovate updates both.

## Development

```sh
node --test 'actions/**/*.test.mjs'
```
