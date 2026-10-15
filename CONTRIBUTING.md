# Contributing to Dhoomberg

Thank you for contributing. Please read this before opening a PR.

## Getting started

```bash
git clone https://github.com/<you>/dhoomberg
cd dhoomberg
npm install
pip install -r requirements.txt
npm start          # server on :8787, Vite on :5173
npm test           # all 100 tests
npm run typecheck  # TypeScript for both browser and server
```

## Ground rules

### ML rigour

Every model must be evaluated against the naive (last-value) baseline using rolling-origin out-of-sample evaluation before it can be shown in the chart. The OOS skill badge is mandatory; removing it or hiding a negative result is not acceptable. Pre-register the metric and threshold before building. If the result is poor, report it honestly and compare it against the naive.

### Order safety

Every new risk limit in `server/orders/guard.ts` needs a test in `tests/guard.test.ts` that proves it rejects. The test must use a real order that would pass without the limit and fails with it. Do not mock the guard function itself.

### Secrets

No plaintext secret may appear in any API response. `tests/server.test.ts` scans every response body for the test secret; do not disable or weaken this scan.

### Server scope

The browser must not make direct calls to third-party APIs. External HTTP calls belong in `server/plugins/`. The Vite proxy `/api` is the only path from browser to the outside world.

## Adding a connector

1. Add a manifest and implementation to `server/plugins/<kind>.ts` following the existing pattern.
2. Register it in the array at the bottom of that file.
3. Add a test for the response parser in `tests/datasource.test.ts` (or the appropriate suite) using a recorded fixture, not a live call.
4. The Settings UI is generated automatically from the JSON Schema — no UI code required.

## Adding a Python plugin example

Put it in `plugins/examples/` and document the `@indicator`/`@model`/`@signal`/`@datasource` parameters at the top of the file. The file must import only `dhoomberg_runtime` and standard-library / requirements.txt packages.

## Pull request checklist

- [ ] `npm test` passes (100/100)
- [ ] `npm run typecheck` is clean
- [ ] `npm run build` is clean
- [ ] New limits have a guard test
- [ ] New connector has a parser test with a fixture
- [ ] No secret appears in any test response
- [ ] ML results include baseline comparison

## Code style

- TypeScript strict mode is on; do not use `any` or non-null assertions.
- No comments that describe *what* the code does — only *why* when it is non-obvious.
- Keep browser and server code cleanly separated. Anything in `shared/` must have zero side effects and no Node or browser globals.
- Python plugins must work with `python -I` (no loading from the current directory).

## Reporting issues

Please include:

- OS and Node version (`node --version`)
- Python version (`python --version`) if the issue involves Python plugins
- The full error from the server log (visible in the terminal where `npm start` runs)
- Steps to reproduce
