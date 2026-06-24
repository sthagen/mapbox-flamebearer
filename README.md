# 🔥 flamebearer

A CLI that summarizes performance traces for AI agents and humans. Reads Chrome DevTools Performance recordings (`.json` / `.json.gz`) and Node `.cpuprofile` files, and prints a compact, structured text report — heaviest call stacks, top CPU offenders and hot source lines per thread, long tasks, category breakdown — designed to fit in an LLM's context window in one shot.

No HTML, no GUI: [Speedscope](https://www.speedscope.app/) already nails that.

## Usage

```bash
npm install -g flamebearer

# Chrome DevTools trace (.json / .json.gz)
flamebearer profile.json.gz

# Node CPU profile — single file, multiple files, or a folder of profiles
node --cpu-prof app.js
flamebearer CPU.*.cpuprofile

# Profile a Node script in one step (wraps `node --cpu-prof`)
flamebearer-node bench.js
flamebearer-node bench.js arg1 arg2 -- --top 30 --thread main
```

With no flags, you get a one-page report per thread: a category breakdown,
the heaviest call stacks (a "left-heavy" call tree), top CPU offenders by self
time, hot source lines, and — for Chrome traces — long tasks (>50ms). Each
frame is shown with its resolved `file:line`, and common URL prefixes are
stripped to keep the output compact.

### Drilling down

```bash
flamebearer trace.json --stacks parseConfig   # callers, callees, hot paths,
                                               # and hot lines for one function
flamebearer trace.json --thread main --top 30 # restrict threads, more rows
flamebearer trace.json --from 1200 --to 1800  # slice a time range (ms)
```

Run `flamebearer --help` for the full flag list.

### Source maps

Minified frames are de-minified automatically: flamebearer resolves sibling
`.map` files for `file://` URLs, inline `//# sourceMappingURL=data:...` maps,
and source maps DevTools embeds in the trace (the "include source maps"
toggle). Pass `--no-sourcemap` to skip resolution.

## Note on v1

This project used to be about generating an HTML flamegraph for Node traces, but then lay dormant since 2018. In 2026, it was revived with a new purpose: to be a useful CLI tool in the age of AI.

## Thanks

- [Brendan Gregg](http://brendangregg.com/) for creating the [flamegraph concept](https://queue.acm.org/detail.cfm?id=2927301) and maintaining the [reference implementation](http://brendangregg.com/flamegraphs.html).
- [David Mark Clements](https://github.com/davidmarkclements) for creating [0x](https://github.com/davidmarkclements/0x) which originally inspired this project.
- [Bernard Cornwell](http://www.bernardcornwell.net/books/) for the amazing books this project took its name from.
