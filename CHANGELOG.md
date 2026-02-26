# Changelog

## [0.2.1](https://github.com/dungle-scrubs/hippo/compare/hippo-v0.2.0...hippo-v0.2.1) (2026-02-26)


### Added

* add scoped recall fixes and dashboard chunk mutation APIs ([#8](https://github.com/dungle-scrubs/hippo/issues/8)) ([819d0f3](https://github.com/dungle-scrubs/hippo/commit/819d0f3d7aa9e99694c61bd784cb577290a7bebe))


### Documentation

* correct MCP server tool count in README ([6e3d661](https://github.com/dungle-scrubs/hippo/commit/6e3d661074d0f6d232b0f3b47dd82cf2a0a4face))

## [0.2.0](https://github.com/dungle-scrubs/hippo/compare/hippo-v0.1.0...hippo-v0.2.0) (2026-02-24)


### ⚠ BREAKING CHANGES

* fix MCP server tool duplication, add recall kind filter ([#6](https://github.com/dungle-scrubs/hippo/issues/6))
* rename to @dungle-scrubs/hippo, prepare for npm publish

### Added

* **cli:** add database inspection and management CLI ([3996c4d](https://github.com/dungle-scrubs/hippo/commit/3996c4db0cc24f8aac89121c0ce9c60b0e28a5c3))
* fix MCP server tool duplication, add recall kind filter ([#6](https://github.com/dungle-scrubs/hippo/issues/6)) ([684f53e](https://github.com/dungle-scrubs/hippo/commit/684f53e343a0ed39459dd9c4deab3a7cd80cf7f9))
* implement hippo memory system ([17c9985](https://github.com/dungle-scrubs/hippo/commit/17c9985b511af510791d87fc38c41102a2d136ce))
* input guards, block size warnings, schema docs ([25bf5f7](https://github.com/dungle-scrubs/hippo/commit/25bf5f7730ed35eb9cc6849f9a1627c17c90fbed))
* MCP server with OpenAI-compatible providers ([3c2bec7](https://github.com/dungle-scrubs/hippo/commit/3c2bec776550022ebe0f507624ce135d96a97ee9))
* rename to @dungle-scrubs/hippo, prepare for npm publish ([090bf72](https://github.com/dungle-scrubs/hippo/commit/090bf72ee13548efc900dacc491ce609967ac792))
* **schema:** add created_at index for future recency pre-filtering ([8f95abd](https://github.com/dungle-scrubs/hippo/commit/8f95abd89db6e73fe1398792fb1649a4baf41ed3))


### Fixed

* atomic SUPERSEDES, classification parsing, agent-scoped cleanup ([eb20e53](https://github.com/dungle-scrubs/hippo/commit/eb20e5353342d55e99c94fe40dc70d162a7013eb))
* audit fixes — bugs, risks, test gaps ([c39157d](https://github.com/dungle-scrubs/hippo/commit/c39157dc187b9a50bf075771fc490d8ca408fe52))
* audit fixes — bugs, risks, test gaps ([d3f5a5a](https://github.com/dungle-scrubs/hippo/commit/d3f5a5a44ae88d1e3baa5b83003653b087f86556))
* **forget-memory:** wrap deletes in transaction ([b96b8d6](https://github.com/dungle-scrubs/hippo/commit/b96b8d6e57c15233b63dbf03de15cfe2ad7f22f9))
* **recall-conversation:** distinguish FTS table missing from query errors ([6843528](https://github.com/dungle-scrubs/hippo/commit/68435280ed7960ad82a738d6ac299610153c7598))
* **recall-conversation:** only catch SQLITE_ERROR ([cbef991](https://github.com/dungle-scrubs/hippo/commit/cbef991695270d1924c4b1b4b54ac896d3c48641))
* **recall-memories:** add similarity floor to filter irrelevant results ([a1571f6](https://github.com/dungle-scrubs/hippo/commit/a1571f6a018402911423a1f27b85a596ca6d6283))
* **recall-memories:** guard retrieval boost, single query ([fccd0c2](https://github.com/dungle-scrubs/hippo/commit/fccd0c2289b02f823491a491e34ec6400c437987))
* **recall-memories:** re-throw non-transient boost errors ([da87567](https://github.com/dungle-scrubs/hippo/commit/da8756703199c9b42e560e6d36cc251864bc5807))
* **remember-facts:** cap existing facts loaded for conflict resolution ([481d6db](https://github.com/dungle-scrubs/hippo/commit/481d6db2c6ad43a072b0c5aafe8685ab1f7feebe))
* signal propagation, intra-batch dedup, metadata validation, search cap ([9faf64a](https://github.com/dungle-scrubs/hippo/commit/9faf64ad45ccaf3178c7f0ca42d15d504e1989e5))
* **store-memory:** conditional truncation in display ([f87b7d1](https://github.com/dungle-scrubs/hippo/commit/f87b7d1c9876da003fdbc725e93d88056697181b))
* **store-memory:** handle TOCTOU race on concurrent duplicate inserts ([3754b3d](https://github.com/dungle-scrubs/hippo/commit/3754b3de3fec880bf5515ccaef7df4a96eb29b54))


### Changed

* add chunkEmbedding helper and getAllActiveChunks query ([563f369](https://github.com/dungle-scrubs/hippo/commit/563f369fbd6f03d63affce38b8bacd70207e1e1b))
* **hash:** use sync node:crypto for contentHash ([fae0044](https://github.com/dungle-scrubs/hippo/commit/fae0044730b57cfb835dd7b02c3dc2fe27807e09))


### Documentation

* add logo to README ([85b514b](https://github.com/dungle-scrubs/hippo/commit/85b514b40f571b736433a54c4e72a467a38aba86))
* add README ([30623ae](https://github.com/dungle-scrubs/hippo/commit/30623ae9e8128826561f450f3d722776b8eeffac))
* clarify dependency requirements per usage mode ([c8e03a2](https://github.com/dungle-scrubs/hippo/commit/c8e03a2228d54255226bb593252615dd67f832bb))
* document MCP server, CLI, built-in providers, and exports ([751f36f](https://github.com/dungle-scrubs/hippo/commit/751f36f80cbdee66b3c9d15b2007dccb8a1b098c))
* sync plan.md with implementation ([32bf87e](https://github.com/dungle-scrubs/hippo/commit/32bf87e2b03e240bc2a70b9f28b34d96f826defc))


### Maintenance

* add biome, husky, vitest, deps ([c839d58](https://github.com/dungle-scrubs/hippo/commit/c839d5878f3cc0cb90d41fbabaa38ffe527a51db))
* add CI, TruffleHog, Dependabot, release-please, and publish workflows ([8598c61](https://github.com/dungle-scrubs/hippo/commit/8598c61943746d2834074489d4ae9ebeb2fa2c60))
* add justfile and tsconfig.build.json ([952d2d7](https://github.com/dungle-scrubs/hippo/commit/952d2d7885c3def3caced5a73cc6c3e3329c3b9c))
* add LICENSE, CONTRIBUTING, SECURITY, templates, update gitignore ([dd85b07](https://github.com/dungle-scrubs/hippo/commit/dd85b07c19975ea4d3ec6cebb7e27a538c3ff3ae))
* add logo and social share image ([8178dfb](https://github.com/dungle-scrubs/hippo/commit/8178dfb79595d07b146bfd4df29bfb10e0c04bbb))
* add missing audit coverage ([82299f7](https://github.com/dungle-scrubs/hippo/commit/82299f7f2aa6f33851ce919e2720804ba97734b6))
* configure release-please with version sync markers ([0dfa08d](https://github.com/dungle-scrubs/hippo/commit/0dfa08d5363778a9e0cfa5330588f44821ea4d32))
* fill coverage gaps ([1c8b037](https://github.com/dungle-scrubs/hippo/commit/1c8b037f184438dacd2f99c6ec8e6d47a3c9edd3))
* initial scaffold ([5d3c73e](https://github.com/dungle-scrubs/hippo/commit/5d3c73eae2d7e4a77fe2c9168d4cddfbed6c5a0c))
* peer deps, exports map ([9aebf15](https://github.com/dungle-scrubs/hippo/commit/9aebf15186aa6138207e96b9881b423f6008df11))
* **remember-facts:** add missing audit coverage ([0bb7705](https://github.com/dungle-scrubs/hippo/commit/0bb7705843406d5df171321d24137824805f1348))

## Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
