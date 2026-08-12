# Contributing

## Branch workflow

Two standing branches: `main` (release truth, changes arrive only via PRs) and `Development` (clean integration branch).

- Create every work branch off `Development`, never off `main`.
- Ship a completed branch as a PR into `Development`.
- Releases are PRs from `Development` into `main`.
- Keep branches short-lived and delete them after their PR merges.

## Checks

Run the mandatory gates listed in AGENTS.md (build, tests, typecheck, extension syntax, manifest check) before opening a PR, and report the actual command output.
