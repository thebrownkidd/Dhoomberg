## Summary

<!-- What does this change and why? -->

## Type

- [ ] Bug fix
- [ ] New connector / plugin
- [ ] New indicator or model
- [ ] Order / risk guard change
- [ ] Frontend / UI
- [ ] Documentation
- [ ] Other

## Checklist

- [ ] `npm test` passes (100/100)
- [ ] `npm run typecheck` is clean
- [ ] `npm run build` is clean
- [ ] New order-guard limits have a rejection test in `tests/guard.test.ts`
- [ ] New connectors have a parser test with a fixture (no live API calls in tests)
- [ ] No secret appears in any test response
- [ ] ML results include baseline comparison (OOS skill vs naive)
