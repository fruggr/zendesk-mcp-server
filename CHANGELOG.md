## [1.2.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.1.3...v1.2.0) (2026-06-04)

### Features

* **help-center:** expose article sort position on update_article ([#61](https://github.com/fruggr/zendesk-mcp-server/issues/61)) ([04f899c](https://github.com/fruggr/zendesk-mcp-server/commit/04f899cbb4cbb78ba7f8139f5abcc1ef607a02b5))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **deps:** lock file maintenance ([#49](https://github.com/fruggr/zendesk-mcp-server/issues/49)) ([c5145d0](https://github.com/fruggr/zendesk-mcp-server/commit/c5145d02332c315a9f4a222f7fd72251dcd30ed9))
* **deps:** update pnpm to v11.4.0 ([#59](https://github.com/fruggr/zendesk-mcp-server/issues/59)) ([138d8eb](https://github.com/fruggr/zendesk-mcp-server/commit/138d8ebbe01b32ea89f18fff53f3537be9ca61d6))

### Continuous Integration

* **release:** fold non-triggering commit types into a collapsed notes section ([#58](https://github.com/fruggr/zendesk-mcp-server/issues/58)) ([5050510](https://github.com/fruggr/zendesk-mcp-server/commit/5050510b6c7ec83e98b3e5bab8aba43934682d38))
</details>

## [1.1.3](https://github.com/fruggr/zendesk-mcp-server/compare/v1.1.2...v1.1.3) (2026-05-31)

### Bug Fixes

* **renovate:** make the supply-chain delay policy coherent (lockfile + security) ([#55](https://github.com/fruggr/zendesk-mcp-server/issues/55)) ([f54d7b2](https://github.com/fruggr/zendesk-mcp-server/commit/f54d7b2847439851deb32e354a7a0f00caca1a36))

## [1.1.2](https://github.com/fruggr/zendesk-mcp-server/compare/v1.1.1...v1.1.2) (2026-05-24)

### Bug Fixes

* **security:** patch transitive vulns + enable Renovate lockfile maintenance ([#26](https://github.com/fruggr/zendesk-mcp-server/issues/26)) ([cd49c00](https://github.com/fruggr/zendesk-mcp-server/commit/cd49c0069a5f6a1df37d5613db99eb6986a965f5))

## [1.1.1](https://github.com/fruggr/zendesk-mcp-server/compare/v1.1.0...v1.1.1) (2026-05-21)

### Bug Fixes

* **ci:** upgrade npm to support OIDC Trusted Publishing + recover v1.1.0 ([#16](https://github.com/fruggr/zendesk-mcp-server/issues/16)) ([5314cfd](https://github.com/fruggr/zendesk-mcp-server/commit/5314cfd31d4c2d561e2c533e4d58342894c8d4a1)), closes [#10](https://github.com/fruggr/zendesk-mcp-server/issues/10)

## [1.1.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.0.0...v1.1.0) (2026-05-18)

### Features

* **tickets:** add get_ticket_attachments tool ([#13](https://github.com/fruggr/zendesk-mcp-server/issues/13)) ([3eef08c](https://github.com/fruggr/zendesk-mcp-server/commit/3eef08c29da601eba2bb7e34f9f314ce4a872b79))

## 1.0.0 (2026-04-24)

### ⚠ BREAKING CHANGES

* package name changed from
`@digital4better/zendesk-mcp-server` to `@fruggr/zendesk-mcp-server`.
Install paths that used the GitHub source
(`github:fruggr/zendesk-mcp-server`) must switch to
`@fruggr/zendesk-mcp-server` on npm. The `prepare` script was removed;
builds on install are no longer triggered — use `pnpm build`
explicitly in development workflows.

### Features

* add content tags, labels, user segments, attachments tools and enrich article create/update ([285e45d](https://github.com/fruggr/zendesk-mcp-server/commit/285e45d5fe464047bf2cc6598c8cd520fcbd223e))
* add permission_group_id to create_article and list_permission_groups tool ([df89569](https://github.com/fruggr/zendesk-mcp-server/commit/df895696affdcf965dfeb6957d105f68b84e1cc0))
* **help-center:** add section-based article editing ([fd66f9c](https://github.com/fruggr/zendesk-mcp-server/commit/fd66f9c7a0de57a510fa22f58b25885c5318b43a))
* **help-center:** nudge LLMs toward section-scoped article tools ([7abf308](https://github.com/fruggr/zendesk-mcp-server/commit/7abf308093b75b74ebbb2af980b2d22298b35819))
* publish to npm under [@fruggr](https://github.com/fruggr) with automated semantic-release ([972ae68](https://github.com/fruggr/zendesk-mcp-server/commit/972ae68ca7d3ade1700da6496082673cb53da1fd))

### Bug Fixes

* **auth:** use `open` package for cross-platform browser launch ([65ca70f](https://github.com/fruggr/zendesk-mcp-server/commit/65ca70f968f3b8efa80a20f3f7e00822a6891fa2))
* **ci:** bump release workflow to node 22 for semantic-release ([85ecadc](https://github.com/fruggr/zendesk-mcp-server/commit/85ecadcd6e485c65c00b838e4eb638f71714ba71))
* **ci:** wire NODE_AUTH_TOKEN so .npmrc resolves to the real token ([723ccb0](https://github.com/fruggr/zendesk-mcp-server/commit/723ccb0ac5e2367b01b0a7e08373c8919bb2ba29))
* **help-center:** make section reads/writes round-trip safe by default ([8bba517](https://github.com/fruggr/zendesk-mcp-server/commit/8bba5174ada6fcc90e96118336d55a11d40be077))
* **help-center:** replace turndown + marked with unified ESM pipeline ([4a8ea31](https://github.com/fruggr/zendesk-mcp-server/commit/4a8ea318379fabc479900978fe8433585343cf38))
* remove title/body from update_article, improve tool descriptions ([5339648](https://github.com/fruggr/zendesk-mcp-server/commit/53396487125a7cd78db172b33361d7b9557e42a3))

### Performance Improvements

* **server:** shorten proxy tool descriptions to first sentence only ([0090596](https://github.com/fruggr/zendesk-mcp-server/commit/0090596e9b4b4ba0af7662a08a286e5c56e62cd5))
