# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/clickmamaheti-prog/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/clickmamaheti-prog/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four formats, to a tree of files. `SPEC.md` is the whole specification.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `--format=NAME`: `unified`, `search-replace`, `v4a`, `json`, or `auto` (default, detects the format).
- `--check`: do everything but write, same output and exit code.
- `--strict`: match lines exactly (tier 0 only).
- `PATCH`: path of the patch file, or `-` / absent to read from standard input.

Node 22, standard library only. `SPEC.md` is the contract; `runner.ts` is the kit runner (kept as-is); `check.ts` runs the practice set on your own machine:

```
node check.ts ../program/generator/practice.json
```

## License

MIT. See `LICENSE`.
