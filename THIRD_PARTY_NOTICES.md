# Third-party notices

## dsh-session-lazy-view

This local experimental adaptation starts from `240xu/dsh-session-lazy-view` version 0.3.6, commit `6224eb1e41b9408de1a9aec2749a21a4e0c8f31d`.
Upstream: https://github.com/240xu/dsh-session-lazy-view
Copyright (c) 2026 240xu. MIT; the original license is retained in `LICENSE`.
The legacy viewer source and `/lazyview` route have been removed from this package. The upstream source provenance and MIT license attribution above are retained; see `LICENSE` for the original license.

## DeepSeek Harness

The storage adapter is generated at Host activation from the installed matching `@deepseek-ai/dsh-session-persistence-jsonl` package. It is kept in a private temporary directory for that Fiber lifetime; no version-specific DSH implementation is shipped in this package.
Source: https://github.com/deepseek-ai/deepseek-harness
Copyright (c) 2026 DeepSeek. MIT; generated runtime snapshot retains the source package's `LICENSE` in that temporary directory.

The structural Zstandard parser in `lib/disk-reader.js` is adapted from the same native package's `src/zstd.ts`, with its MIT notice inline. There is no external payload database or duplicated user transcript.

The local adapter resolves official dependencies from the user's matching DSH installation; it does not redistribute a second Cordis, React or Session runtime. DSH and persistence package versions must match, and unknown persistence class/method layouts fail closed.
