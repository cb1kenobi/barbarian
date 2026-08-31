# Language focus

## JavaScript and TypeScript

- Floating promises, async callbacks passed to `forEach`, missing cancellation, swallowed rejections.
- `||` where `0` or an empty string is valid, unchecked nulls, mutation shared across requests.
- Blocking filesystem or process work on request paths; repeated parsing or allocation in loops.
- `any`, unchecked casts, non-null assertions, and type guards that promise more than runtime checks prove.

## C++

- Ownership, lifetime, iterator invalidation, bounds, undefined behavior, and incomplete RAII cleanup.
- Lock order, data races, atomics, and resources held while calling unknown or blocking code.
- Distinguish EOF, truncation, and I/O failure. Use filesystem path operations rather than string separators.

## Rust

- Verify every `unsafe` invariant, FFI boundary, `Send`/`Sync` assumption, and lock held across `.await`.
- Production `unwrap`/`expect`, lost error context, unnecessary clones, and interior mutability used to fight the design.

## Markdown, config, SQL, and build files

- Broken links, stale examples, invalid YAML, dangerous defaults, secret exposure, migration reversibility, missing indexes for actual queries, non-portable shell assumptions, and dependency lifecycle scripts.

