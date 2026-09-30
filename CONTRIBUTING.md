# Developing the Wity TypeScript SDK

## Commands

```sh
npm install
npm run check       # typecheck, tests, build
npm run test:live   # real calls through WityClient (2 billed, a tiny amount)
npm run fixtures    # refresh test/fixtures/ from the real API (a tiny amount)
npm run fixtures -- generate-text noul-always   # refresh only the named fixtures
```

- The tests replay real API responses saved in `test/fixtures/`, so they run offline and cost nothing.
- `test:live` and `fixtures` read `WITY_API_KEY` and `WITY_BASE_URL` from the environment, or from a `.env` file in this folder. `.env` is git-ignored.
- The README's example answers are copied from `test/fixtures/multi-auto.json`, `generate-text.json` and `generate-shape.json`. If you refresh those fixtures, update the README to match.

## If the API address changes

1. Update `DEFAULT_BASE_URL` in `src/client.ts`. The tests use that constant, so they follow along.
2. Bump the version.
3. Publish.

Until users update, they can set `WITY_BASE_URL` to the new address.

## Publishing

1. Remove `"private": true` from `package.json`. It's there so nobody publishes by accident.
2. Run `npm publish`. `prepublishOnly` runs `npm run check` first, and the package goes out as public.
