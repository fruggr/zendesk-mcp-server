## [2.4.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.3.1...v2.4.0) (2026-06-30)

### Features

* publish to the official MCP registry on release ([#105](https://github.com/fruggr/zendesk-mcp-server/issues/105)) ([eb08049](https://github.com/fruggr/zendesk-mcp-server/commit/eb080494a1212aace5369e39ddcfa80324961e59))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **deps:** update dependency @biomejs/biome to v2.5.1 ([#107](https://github.com/fruggr/zendesk-mcp-server/issues/107)) ([dbab4ff](https://github.com/fruggr/zendesk-mcp-server/commit/dbab4ffaf25a883aaba0cf67d3f488644bc9f7fc))

### Tests

* **release:** guard conventionalcommits preset rendering against breaking majors ([#104](https://github.com/fruggr/zendesk-mcp-server/issues/104)) ([a61f143](https://github.com/fruggr/zendesk-mcp-server/commit/a61f1438895140963d1e08e5a5c28bf08c73ba99))
</details>

## [2.3.1](https://github.com/fruggr/zendesk-mcp-server/compare/v2.3.0...v2.3.1) (2026-06-27)

### Bug Fixes

* reject unknown tool params and fix list pagination footer ([#100](https://github.com/fruggr/zendesk-mcp-server/issues/100)) ([#102](https://github.com/fruggr/zendesk-mcp-server/issues/102)) ([b5c7aa9](https://github.com/fruggr/zendesk-mcp-server/commit/b5c7aa970655cc2c87cfc5eb39629aceb0b935e2))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **deps:** lock file maintenance ([#99](https://github.com/fruggr/zendesk-mcp-server/issues/99)) ([97849fe](https://github.com/fruggr/zendesk-mcp-server/commit/97849feb202da7c2c075210ba45eb989877ad45a))
* **deps:** update actions/checkout action to v7 ([#101](https://github.com/fruggr/zendesk-mcp-server/issues/101)) ([d805dd5](https://github.com/fruggr/zendesk-mcp-server/commit/d805dd5382eeddb8d40f253dc7ba868b5e65f39d))
* **deps:** update dependency @biomejs/biome to v2.5.0 ([#95](https://github.com/fruggr/zendesk-mcp-server/issues/95)) ([7d17d32](https://github.com/fruggr/zendesk-mcp-server/commit/7d17d3253454ee54c3ae761ff7492b959c083974))
* **deps:** update pnpm to v11.7.0 ([#96](https://github.com/fruggr/zendesk-mcp-server/issues/96)) ([3be769b](https://github.com/fruggr/zendesk-mcp-server/commit/3be769b572158dfecbc1341df4d3cb472bdaafa3))
* **deps:** update pnpm to v11.8.0 ([#98](https://github.com/fruggr/zendesk-mcp-server/issues/98)) ([75726ad](https://github.com/fruggr/zendesk-mcp-server/commit/75726ad2a798e24ca319ae94b7c5bb92a13b7a5c))
* **lint:** enable a conservative set of new Biome 2.5 rules ([#97](https://github.com/fruggr/zendesk-mcp-server/issues/97)) ([ec8789e](https://github.com/fruggr/zendesk-mcp-server/commit/ec8789e3b2f064786490f72e602ad5a3ea6eea5b))
</details>

## [2.3.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.2.0...v2.3.0) (2026-06-19)

### Features

* surface live SLA state on tickets and add list_sla_policies ([#93](https://github.com/fruggr/zendesk-mcp-server/issues/93)) ([e428b2b](https://github.com/fruggr/zendesk-mcp-server/commit/e428b2b62f9b0bc3f237e82c5f99c1bc60efebda))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Documentation

* lead README with the assistant experience (M365 Copilot vocabulary) ([#90](https://github.com/fruggr/zendesk-mcp-server/issues/90)) ([19b98e6](https://github.com/fruggr/zendesk-mcp-server/commit/19b98e6560f698635810587b6fe795e83e213537))

### Chores

* **deps:** update pnpm to v11.5.3 ([#91](https://github.com/fruggr/zendesk-mcp-server/issues/91)) ([62f058c](https://github.com/fruggr/zendesk-mcp-server/commit/62f058c3f7d4827e28016df55ef4f70afe1527dd))
* **deps:** update pnpm to v11.6.0 ([#94](https://github.com/fruggr/zendesk-mcp-server/issues/94)) ([9b7f8c6](https://github.com/fruggr/zendesk-mcp-server/commit/9b7f8c6f1f2ef355baa05c9dc06adccb80b98c7e))
</details>

## [2.2.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.1.0...v2.2.0) (2026-06-14)

### Features

* **auth:** refresh OAuth tokens proactively and in the background ([#88](https://github.com/fruggr/zendesk-mcp-server/issues/88)) ([72859a3](https://github.com/fruggr/zendesk-mcp-server/commit/72859a3b5bd6160eed9c1e91899b1f1126297b8f))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* fix language hook false positives on typographic chars ([#87](https://github.com/fruggr/zendesk-mcp-server/issues/87)) ([1db8a07](https://github.com/fruggr/zendesk-mcp-server/commit/1db8a077276dce57631cb4632fcbb3f7543f39fe))
* generalize AI assistant wording on OAuth success page ([#89](https://github.com/fruggr/zendesk-mcp-server/issues/89)) ([0fccac1](https://github.com/fruggr/zendesk-mcp-server/commit/0fccac1d8b39558a7aea052c3d6c570f5963003c))
</details>

## [2.1.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.0.1...v2.1.0) (2026-06-13)

### Features

* **help-center:** expose structural topology via instructions + resource ([#83](https://github.com/fruggr/zendesk-mcp-server/issues/83)) ([9aad9a9](https://github.com/fruggr/zendesk-mcp-server/commit/9aad9a979366785b45332b51a2efedace4c666c2))

## [2.0.1](https://github.com/fruggr/zendesk-mcp-server/compare/v2.0.0...v2.0.1) (2026-06-13)

### Bug Fixes

* **tools:** enrich descriptions and parameters of low-scoring tools ([#85](https://github.com/fruggr/zendesk-mcp-server/issues/85)) ([7e63159](https://github.com/fruggr/zendesk-mcp-server/commit/7e6315970a4e4f170952717d5698cca42a876cbc))

## [2.0.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.9.1...v2.0.0) (2026-06-13)

### ⚠ BREAKING CHANGES

* OAuth-only (local + remote), drop static API-token auth (#84)

### Features

* OAuth-only (local + remote), drop static API-token auth ([#84](https://github.com/fruggr/zendesk-mcp-server/issues/84)) ([486c15a](https://github.com/fruggr/zendesk-mcp-server/commit/486c15a2056ca7cab32d1ae74199e218cea98e31))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* disable Claude co-author attribution in commits and PRs ([#82](https://github.com/fruggr/zendesk-mcp-server/issues/82)) ([0342f34](https://github.com/fruggr/zendesk-mcp-server/commit/0342f346dd4bbde84a10d6c04c14a55767d61f6f))
</details>

## [1.9.1](https://github.com/fruggr/zendesk-mcp-server/compare/v1.9.0...v1.9.1) (2026-06-12)

### Bug Fixes

* send content_tag wrapper when creating Guide content tags ([#81](https://github.com/fruggr/zendesk-mcp-server/issues/81)) ([db38a80](https://github.com/fruggr/zendesk-mcp-server/commit/db38a80f4ac3b677db4f892774b3a3db77587232))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **deps:** lock file maintenance ([#78](https://github.com/fruggr/zendesk-mcp-server/issues/78)) ([f9a3d36](https://github.com/fruggr/zendesk-mcp-server/commit/f9a3d36a1389647fbc874bd370ed329bdef06d2e))
* **deps:** update pnpm to v11.5.2 ([#80](https://github.com/fruggr/zendesk-mcp-server/issues/80)) ([9ddd3b1](https://github.com/fruggr/zendesk-mcp-server/commit/9ddd3b172662356b095b3efc2f002ceda5bd9630))
</details>

## [1.9.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.8.0...v1.9.0) (2026-06-10)

### Features

* remote MCP deployment with per-user OAuth 2.1 PKCE ([#40](https://github.com/fruggr/zendesk-mcp-server/issues/40)) ([5de1dfe](https://github.com/fruggr/zendesk-mcp-server/commit/5de1dfe50eb0a5bb0519392aafdfd7f334f31976))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **deps:** update pnpm to v11.5.1 ([#76](https://github.com/fruggr/zendesk-mcp-server/issues/76)) ([c085dfa](https://github.com/fruggr/zendesk-mcp-server/commit/c085dfa8817a86de2d4585a97e5026d2306729a1))
</details>

## [1.8.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.7.0...v1.8.0) (2026-06-08)

### Features

* **auth:** persist OAuth token to disk, refresh, and make callback port configurable ([#75](https://github.com/fruggr/zendesk-mcp-server/issues/75)) ([0c2ca18](https://github.com/fruggr/zendesk-mcp-server/commit/0c2ca18b021146df9ac945281a2ec41b97475daf))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* add worktrunk hook to pull and install deps on worktree switch ([6a207b8](https://github.com/fruggr/zendesk-mcp-server/commit/6a207b87be631b51b67f4609408314e86ebdb397))
</details>

## [1.7.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.6.0...v1.7.0) (2026-06-07)

### Features

* **auth:** show countdown on OAuth success page before auto-close ([#74](https://github.com/fruggr/zendesk-mcp-server/issues/74)) ([f3caf03](https://github.com/fruggr/zendesk-mcp-server/commit/f3caf034e715ebd86a9a1878475fd1dc374fb977))

## [1.6.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.5.0...v1.6.0) (2026-06-07)

### Features

* **annotations:** expose accurate hints to MCP clients ([#53](https://github.com/fruggr/zendesk-mcp-server/issues/53)) ([566d6af](https://github.com/fruggr/zendesk-mcp-server/commit/566d6afc1237999d125b14e7f61674b2de87bf3b))

## [1.5.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.4.1...v1.5.0) (2026-06-06)

### Features

* **auth:** non-blocking OAuth with the sign-in URL surfaced in the tool response ([#63](https://github.com/fruggr/zendesk-mcp-server/issues/63)) ([2b9ea03](https://github.com/fruggr/zendesk-mcp-server/commit/2b9ea0351d60af41ab15e08a6fce36f3c7bb2d69))

## [1.4.1](https://github.com/fruggr/zendesk-mcp-server/compare/v1.4.0...v1.4.1) (2026-06-06)

### Bug Fixes

* **auth:** escape reflected values in OAuth callback HTML responses ([#73](https://github.com/fruggr/zendesk-mcp-server/issues/73)) ([6432d8f](https://github.com/fruggr/zendesk-mcp-server/commit/6432d8fe40414ec344804fb13390dc217dc68fec))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Documentation

* add trust badges to README ([#70](https://github.com/fruggr/zendesk-mcp-server/issues/70)) ([73e859f](https://github.com/fruggr/zendesk-mcp-server/commit/73e859f7e08a2fd587426dc1e5120eb042135e3d))
* harden marketing & discoverability surface ([#71](https://github.com/fruggr/zendesk-mcp-server/issues/71)) ([8009392](https://github.com/fruggr/zendesk-mcp-server/commit/800939216922f868de71bf642fde387f09df5c91))
* slim AGENTS.md down to an agent-focused guide ([#68](https://github.com/fruggr/zendesk-mcp-server/issues/68)) ([29064f8](https://github.com/fruggr/zendesk-mcp-server/commit/29064f82c40298f827586908bbf4071805ae7585))

### Chores

* add glama.json to claim MCP server maintainership ([#69](https://github.com/fruggr/zendesk-mcp-server/issues/69)) ([c47ab27](https://github.com/fruggr/zendesk-mcp-server/commit/c47ab273e546634f6f38b8885cf726bd12b1bd89))
* **deps:** lock file maintenance ([#64](https://github.com/fruggr/zendesk-mcp-server/issues/64)) ([5bfb1d3](https://github.com/fruggr/zendesk-mcp-server/commit/5bfb1d3f7bdde885f772ca6a0a9769d631af83e1))
* **deps:** update pnpm to v11.5.0 ([#67](https://github.com/fruggr/zendesk-mcp-server/issues/67)) ([637c90b](https://github.com/fruggr/zendesk-mcp-server/commit/637c90b4d95476e287b03a0219bcc53e6b740bc2))
* **renovate:** clear lockFileMaintenance minimumReleaseAge dashboard warning ([#65](https://github.com/fruggr/zendesk-mcp-server/issues/65)) ([3b42309](https://github.com/fruggr/zendesk-mcp-server/commit/3b42309e543625204886756504fad9dc26eb9894))
* resolve Biome warnings and harden lint setup ([#66](https://github.com/fruggr/zendesk-mcp-server/issues/66)) ([c0612c3](https://github.com/fruggr/zendesk-mcp-server/commit/c0612c3f41513446a3150f2b7e32dfb2edf0cfc8))
</details>

## [1.4.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.3.0...v1.4.0) (2026-06-04)

### Features

* **auth:** add structured logging to diagnose the OAuth browser flow ([#62](https://github.com/fruggr/zendesk-mcp-server/issues/62)) ([797292c](https://github.com/fruggr/zendesk-mcp-server/commit/797292cc0a33705ea1fd6636ccf68e68c3b6e8e6))

## [1.3.0](https://github.com/fruggr/zendesk-mcp-server/compare/v1.2.0...v1.3.0) (2026-06-04)

### Features

* **dev:** enable live testing of the MCP server on a branch ([#54](https://github.com/fruggr/zendesk-mcp-server/issues/54)) ([a19a531](https://github.com/fruggr/zendesk-mcp-server/commit/a19a53162da359a769bab6dc8f34951ac59588e0))

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
