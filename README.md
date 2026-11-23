# sitegen-faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/rajupramana370/sitegen-faster/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/rajupramana370/sitegen-faster/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

SiteForge is a dependency-free reimplementation of makefun-site 1.0.0's build that returns the
reference program's output tree byte for byte — every page, tag page, index page, static file
and the build report — while running about twice as fast on the practice cases. `run(input)` in
solve.js keeps makefun-site's exact semantics (its front matter refusals, slug rule, Markdown
dialect, template dialect, link resolution and report), and gets its speed from the hot paths:
bulk HTML escaping with a no-specials fast path, a memoised slugifier with an ASCII fast path,
first-character dispatch in the Markdown lexer instead of per-line regex batteries, a
single-pass inline renderer whose finders jump with indexOf, indexOf-scanned front matter (the
body is one slice, never split and rejoined), link resolutions memoised per case, and a template
renderer that appends to a shared parts array instead of concatenating strings node by node. It
reads no clock, no environment, no randomness and no file: the output is a function of the
input alone, so two runs on the same input produce identical answers.

## Run it

```sh
# The harness driver reads /input/cases.json and writes /output/answers.json
# (MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in for them outside a container):
MAKEFUN_INPUT_DIR=<dir-with-cases.json> MAKEFUN_OUTPUT_DIR=<out-dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=raju-pramana&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
