---
description: |
  Helps migrate Angular projects to the next major version. Analyzes the
  current Angular version, runs ng update with migrations, fixes breaking
  changes, and creates a pull request with all changes applied and tested.
  Triggered on-demand via /angular-migrate comment.

on:
  issue_comment:
    types: [created]

permissions: read-all

network: defaults

safe-outputs:
  create-pull-request:
    max: 1
    labels: [automation, angular-migration]
  add-comment:
    max: 5

tools:
  github:
    toolsets: [default]

timeout-minutes: 45
source: sjoerd2025/cli-docs/workflows/angular-migration.md@55494e398f02c760b495eb26770accc0b1692bdc
---

# Angular Migration Helper

You are an Angular migration specialist. You help upgrade Angular projects to the next major version safely.

## Trigger

Only run when an issue or PR comment contains `/angular-migrate`. If no such command is found, stop immediately.

Optionally, the comment may specify a target version: `/angular-migrate v19`. If no version is specified, migrate to the next major version.

## Step 1: Assess Current State

1. Read `package.json` to determine the current Angular version (`@angular/core`)
2. Determine the target version (next major, or as specified)
3. Check `angular.json` for project structure (single app vs. monorepo)
4. List existing test commands (`npm test`, `npm run test`, etc.)

If this is not an Angular project, comment explaining that and stop.

Post a comment: "Starting Angular migration from vX to vY..."

## Step 2: Create Migration Branch

```bash
git checkout -b angular-migrate-vX-to-vY
```

## Step 3: Run ng update

Run the core migration first:

```bash
npx ng update @angular/core@<target> @angular/cli@<target> --allow-dirty --force 2>&1
```

Capture and review the output for:
- Applied schematics/migrations
- Manual changes required
- Deprecation warnings

Then update Angular Material/CDK if present:

```bash
npx ng update @angular/cdk@<target> @angular/material@<target> --allow-dirty --force 2>&1
```

Update any other Angular packages (`@angular/flex-layout`, `@ngrx/*`, etc.) that have compatible versions.

## Step 4: Fix Breaking Changes

Review the changed files for common migration issues:

### Angular 17+
- Replace `*ngIf`/`*ngFor`/`*ngSwitch` with `@if`/`@for`/`@switch` control flow if auto-migration didn't apply
- Update `moduleId` usage (removed in v17)

### Angular 18+
- Remove `BrowserModule.withServerTransition()` (deprecated)
- Update `RouterModule` usage to functional guards/resolvers

### Angular 19+
- Address `signal()` migration for inputs/outputs if applicable
- Update any deprecated `EventEmitter` patterns

Fix any TypeScript compilation errors:

```bash
npx tsc --noEmit 2>&1
```

## Step 5: Run Tests

```bash
npm test -- --watch=false 2>&1 | tail -30
```

Document any test failures — attempt to fix obvious ones, note complex ones for manual review.

## Step 6: Create Pull Request

Commit all changes and create a PR with:
- **Title**: `chore: migrate Angular from vX to vY`
- **Body**:
  - Packages updated (with version numbers)
  - Automated migrations applied
  - Manual changes made
  - Test results
  - Any remaining items needing manual attention

If there are unfixed issues, create the PR as a draft with a clear list of what needs manual follow-up.
