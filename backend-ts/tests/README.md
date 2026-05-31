# Backend TS Tests

The test suite defines migration boundaries before implementation depth.

Layers:

- `contracts`: shared schemas and compatibility helpers.
- `services`: stateful runtime primitives that can be tested without HTTP.
- `routes`: HTTP compatibility using Fastify `inject`.

Required command sequence:

```bash
npm run typecheck
npm run typecheck:test
npm test
```
