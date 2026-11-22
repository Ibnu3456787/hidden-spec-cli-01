# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ibnu3456787/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Ibnu3456787/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and mend reads all four: a unified diff (often with wrong
line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Every file is changed or nothing is. Built for the
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
bounty on [make.fun](https://make.fun).

## Run it

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree; every path in a patch is relative
to it. `PATCH` is the patch file, or standard input when it is absent or `-`.
`--format` reads one format — `unified`, `search-replace`, `v4a`, `json`, or
`auto` (the default, which detects it). `--check` does everything but write.
`--strict` matches lines exactly. `SPEC.md` is the whole contract.

## What it does

- **Three-tier matching.** An edit's old lines are found at the first tier where
  they occur: exact, then ignoring trailing spaces and tabs, then ignoring
  leading and trailing spaces and tabs — with new lines re-indented to the
  file's own indentation at tier 2. `--strict` is tier 0 only.
- **Unified diffs** with wrong line numbers: each hunk takes the occurrence
  nearest its (drift-adjusted) line number, empty hunks insert, and
  `\ No newline at end of file` is honoured. Creates, deletes and renames
  included; moves print as `R <old> -> <new>`.
- **SEARCH/REPLACE blocks**, including creates from empty old text and
  `ambiguous` when the old lines occur more than once at their tier.
- **V4A patches**: add, delete and update sections, `*** Move to:`, `@@`
  anchors, a cursor that walks the file in order, and `*** End of File`
  chunks anchored to the file's end.
- **JSON edits**: a JSON array or JSON Lines of `create`, `str_replace` and
  `insert` tool calls, with CRLF-aware replacement.
- **Atomicity**: edits apply in order to the tree as earlier edits left it;
  a failed edit changes nothing and the edits after it still run, so every
  failure is reported — and when any edit failed, no file is written.
- **Fidelity**: CRLF files stay CRLF, files without a final line break keep
  none, and unchanged files are left untouched and unlisted.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines
  hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep as is. In a trial it reads the checks from the env, runs
  `node main.ts` on each one in a fresh directory, and posts the results.
- `check.ts`: the practice set on your own machine:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files
it starts with. It passes when the exit code, everything written to stdout and
every file afterwards are exactly what SPEC.md says. stderr is never compared.
Each run has 10 seconds.

## License

MIT — see `LICENSE`.
