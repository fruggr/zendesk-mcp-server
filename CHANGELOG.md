## [2.17.2](https://github.com/fruggr/zendesk-mcp-server/compare/v2.17.1...v2.17.2) (2026-08-12)

### Performance Improvements

* **help-center:** classify translation gaps from the listing sideload ([#226](https://github.com/fruggr/zendesk-mcp-server/issues/226)) ([f5b9ce2](https://github.com/fruggr/zendesk-mcp-server/commit/f5b9ce2ce838a35e8629f37c45d0b2b4d5b5589b))

## [2.17.1](https://github.com/fruggr/zendesk-mcp-server/compare/v2.17.0...v2.17.1) (2026-08-12)

### Bug Fixes

* **config:** fail loudly on flags and env vars with a missing or empty value ([#218](https://github.com/fruggr/zendesk-mcp-server/issues/218)) ([2813f55](https://github.com/fruggr/zendesk-mcp-server/commit/2813f558ac558f223f34a77961d6d3b7ea0f94ac))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **deps:** cut transitive remediation from 14 to 9 days ([#230](https://github.com/fruggr/zendesk-mcp-server/issues/230)) ([828c5de](https://github.com/fruggr/zendesk-mcp-server/commit/828c5ded2fd3376acc732cab4aa1d34c71fdfea5))
</details>

## [2.17.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.16.1...v2.17.0) (2026-08-11)

### Features

* **help-center:** section & category translation tools ([#224](https://github.com/fruggr/zendesk-mcp-server/issues/224)) ([#225](https://github.com/fruggr/zendesk-mcp-server/issues/225)) ([6bbed8e](https://github.com/fruggr/zendesk-mcp-server/commit/6bbed8e2db1e3aa99a2fbc0c20c5aefc72377598))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Documentation

* humanize the README and its companion docs ([#217](https://github.com/fruggr/zendesk-mcp-server/issues/217)) ([193e8f6](https://github.com/fruggr/zendesk-mcp-server/commit/193e8f6677b7a020fb66c9a439f9d57e5add2a6f))
* refocus the README on why/what and cut the internal redundancy ([#200](https://github.com/fruggr/zendesk-mcp-server/issues/200)) ([b04e642](https://github.com/fruggr/zendesk-mcp-server/commit/b04e64202991cc02b44fb80d2e242606802850b4))

### Chores

* **deps:** lock file maintenance ([#219](https://github.com/fruggr/zendesk-mcp-server/issues/219)) ([25b49da](https://github.com/fruggr/zendesk-mcp-server/commit/25b49dae41f906c1be16143854b5092a501f6e7e))
* **deps:** lock file maintenance ([#220](https://github.com/fruggr/zendesk-mcp-server/issues/220)) ([e238355](https://github.com/fruggr/zendesk-mcp-server/commit/e2383550e274d424a519f5c339effcf17625eaee))
* **deps:** update dependency @biomejs/biome to v2.5.6 ([#204](https://github.com/fruggr/zendesk-mcp-server/issues/204)) ([482e75d](https://github.com/fruggr/zendesk-mcp-server/commit/482e75da064fbd6d16e0aff10e4e133343d8cb0b))
* **deps:** update dependency @biomejs/biome to v2.5.7 ([#227](https://github.com/fruggr/zendesk-mcp-server/issues/227)) ([ce0bdb7](https://github.com/fruggr/zendesk-mcp-server/commit/ce0bdb78ba5e4188e4e1dbb60ad1b38832981a25))
* **deps:** update dependency @modelcontextprotocol/sdk to v1.30.0 ([#201](https://github.com/fruggr/zendesk-mcp-server/issues/201)) ([5689315](https://github.com/fruggr/zendesk-mcp-server/commit/5689315b90db1075bb4bc0a3fa7e6551a89cbdc7))
* **deps:** update pnpm to v11.18.0 ([#216](https://github.com/fruggr/zendesk-mcp-server/issues/216)) ([98ada0d](https://github.com/fruggr/zendesk-mcp-server/commit/98ada0dfa620b10770ae13681567aa2eb473356c))
* **deps:** update pnpm to v11.19.0 ([#221](https://github.com/fruggr/zendesk-mcp-server/issues/221)) ([854fef9](https://github.com/fruggr/zendesk-mcp-server/commit/854fef986156ded7d65248758475df48002c0e2e))
* **deps:** update pnpm to v11.20.0 ([#222](https://github.com/fruggr/zendesk-mcp-server/issues/222)) ([c92be3a](https://github.com/fruggr/zendesk-mcp-server/commit/c92be3abddd0a99e4f1ae9608c21d2ecd98311fb))
* **lint:** check the whole repository, and gate Biome config drift ([#215](https://github.com/fruggr/zendesk-mcp-server/issues/215)) ([1b669c4](https://github.com/fruggr/zendesk-mcp-server/commit/1b669c4084a4771114e2dcedcaf6151a58876e54))

### Tests

* **utils:** add mutation testing, gate PRs on it, and close the assertion gaps it found ([#197](https://github.com/fruggr/zendesk-mcp-server/issues/197)) ([31df70c](https://github.com/fruggr/zendesk-mcp-server/commit/31df70c74cd124a0dab90cb15f272385722aa478))

### Continuous Integration

* push the release commit with a GitHub App token ([#229](https://github.com/fruggr/zendesk-mcp-server/issues/229)) ([e98acd4](https://github.com/fruggr/zendesk-mcp-server/commit/e98acd47eb872e23b9c3bd1e06532d62f1b06c94))
</details>

## [2.16.1](https://github.com/fruggr/zendesk-mcp-server/compare/v2.16.0...v2.16.1) (2026-08-03)

### Bug Fixes

* **logger:** stop a circular field from crashing the caller ([#199](https://github.com/fruggr/zendesk-mcp-server/issues/199)) ([9ffa008](https://github.com/fruggr/zendesk-mcp-server/commit/9ffa00897187b3109075f8f9cdbeb6d36ee01f49))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **build:** trim build dependencies and drop the empty d.ts ([#196](https://github.com/fruggr/zendesk-mcp-server/issues/196)) ([1302fcc](https://github.com/fruggr/zendesk-mcp-server/commit/1302fcc486651dec97b4de66e15128f2b94a22df))
* **deps:** lock file maintenance ([#195](https://github.com/fruggr/zendesk-mcp-server/issues/195)) ([6a085d9](https://github.com/fruggr/zendesk-mcp-server/commit/6a085d97f0613b36fa0fd8f9d485a1f7ef66748e))
* **deps:** update pnpm to v11.17.0 ([#194](https://github.com/fruggr/zendesk-mcp-server/issues/194)) ([8951c29](https://github.com/fruggr/zendesk-mcp-server/commit/8951c293a7acdfe1619ded5c7a965f2176c0ae27))
* **lint:** widen the Biome rule set, and clear what stood in the way ([#188](https://github.com/fruggr/zendesk-mcp-server/issues/188)) ([a44a48e](https://github.com/fruggr/zendesk-mcp-server/commit/a44a48e09556fbbc8dad40de2f918a8a21b76b75))
</details>

## [2.16.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.15.0...v2.16.0) (2026-07-30)

### Features

* **help-center:** expose promoted articles as pull-only MCP resources ([#170](https://github.com/fruggr/zendesk-mcp-server/issues/170)) ([b676695](https://github.com/fruggr/zendesk-mcp-server/commit/b67669512023257df4702ee8e9750d8b5240b06b))

## [2.15.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.14.2...v2.15.0) (2026-07-30)

### Features

* make the Help Center resource URI scheme configurable (param --hc-resource-scheme) ([#173](https://github.com/fruggr/zendesk-mcp-server/issues/173)) ([25d8fbb](https://github.com/fruggr/zendesk-mcp-server/commit/25d8fbbb283debc73696d8033f3d8467e424284a))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Documentation

* fix a stale harness pointer and drop AGENTS.md's directory tour ([#184](https://github.com/fruggr/zendesk-mcp-server/issues/184)) ([137fe0f](https://github.com/fruggr/zendesk-mcp-server/commit/137fe0f973e521921821e4ddd52387121df55f02))

### Chores

* **build:** make install and build work on Android/Termux ([#189](https://github.com/fruggr/zendesk-mcp-server/issues/189)) ([3157d04](https://github.com/fruggr/zendesk-mcp-server/commit/3157d04f78b60ac823530e1179fd076f28a88127))
* **deps:** lock file maintenance ([#179](https://github.com/fruggr/zendesk-mcp-server/issues/179)) ([aecfca0](https://github.com/fruggr/zendesk-mcp-server/commit/aecfca0c02bababc6455caee49207b022dab95b1))
* **deps:** update actions/setup-node action to v7 ([#182](https://github.com/fruggr/zendesk-mcp-server/issues/182)) ([113ee6b](https://github.com/fruggr/zendesk-mcp-server/commit/113ee6b5925cec0c2b1faa97cd05699aac58db06))
* **deps:** update conventional-changelog-conventionalcommits to v10 with a writer 9 override ([#181](https://github.com/fruggr/zendesk-mcp-server/issues/181)) ([5683dc9](https://github.com/fruggr/zendesk-mcp-server/commit/5683dc9ea323f69284a5529690bec4ec9a631a4f))
* **deps:** update dependency @biomejs/biome to v2.5.5 ([#190](https://github.com/fruggr/zendesk-mcp-server/issues/190)) ([988026b](https://github.com/fruggr/zendesk-mcp-server/commit/988026b9c60cd37f5ae4be1e329207470fe0acf5))
* **deps:** update pnpm to v11.13.1 ([#178](https://github.com/fruggr/zendesk-mcp-server/issues/178)) ([239602a](https://github.com/fruggr/zendesk-mcp-server/commit/239602a187ba6eedd334a86004064384423a674c))
* **deps:** update pnpm to v11.14.0 ([#180](https://github.com/fruggr/zendesk-mcp-server/issues/180)) ([c82b709](https://github.com/fruggr/zendesk-mcp-server/commit/c82b70920f8b7b88453a030bd48aaaf42820a223))
* **deps:** update pnpm to v11.15.0 ([#185](https://github.com/fruggr/zendesk-mcp-server/issues/185)) ([36c398d](https://github.com/fruggr/zendesk-mcp-server/commit/36c398d10fe798975c41b8bc63e55f247e0bc8af))
* **deps:** update pnpm to v11.15.1 ([#187](https://github.com/fruggr/zendesk-mcp-server/issues/187)) ([3219b1c](https://github.com/fruggr/zendesk-mcp-server/commit/3219b1cf0655c6761eef7b9e47311e341c359467))
* **deps:** update pnpm to v11.16.0 ([#192](https://github.com/fruggr/zendesk-mcp-server/issues/192)) ([f2523a4](https://github.com/fruggr/zendesk-mcp-server/commit/f2523a4694976f75e5dcad97ea08e78237ad29be))
* **lint:** improve Biome check on Android/Proot plateform ([#183](https://github.com/fruggr/zendesk-mcp-server/issues/183)) ([eb35571](https://github.com/fruggr/zendesk-mcp-server/commit/eb35571f5666869be86cea131aff1153c03ec783))
* **lint:** lint on edit, format at pre-commit ([#186](https://github.com/fruggr/zendesk-mcp-server/issues/186)) ([ea78dd5](https://github.com/fruggr/zendesk-mcp-server/commit/ea78dd51ebc8ea0009b2239dd6a3c2c2ca87555f))
* **lint:** run Biome through a shim so it works on Android/Termux ([#191](https://github.com/fruggr/zendesk-mcp-server/issues/191)) ([15abae9](https://github.com/fruggr/zendesk-mcp-server/commit/15abae94a438344d288b801b7ff1f95d3f5089ef))
</details>

## [2.14.2](https://github.com/fruggr/zendesk-mcp-server/compare/v2.14.1...v2.14.2) (2026-07-22)

### Bug Fixes

* **typecheck:** run native TS 7 under PRoot by un-hardlinking its inputs ([#176](https://github.com/fruggr/zendesk-mcp-server/issues/176)) ([093651d](https://github.com/fruggr/zendesk-mcp-server/commit/093651d64c81b503202cb808f84e9fce715a190a))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **deps:** update actions/github-script action to v9 ([#175](https://github.com/fruggr/zendesk-mcp-server/issues/175)) ([db735ff](https://github.com/fruggr/zendesk-mcp-server/commit/db735ff44b75f4916751ecf488381ea28c83e74d))
* **deps:** update dependency @biomejs/biome to v2.5.4 ([#177](https://github.com/fruggr/zendesk-mcp-server/issues/177)) ([6e242ba](https://github.com/fruggr/zendesk-mcp-server/commit/6e242bae9387d050ade879abd1347fdb445bbea3))
* **renovate:** constrain the typescript-legacy alias to the 6.x line ([#172](https://github.com/fruggr/zendesk-mcp-server/issues/172)) ([f0e5553](https://github.com/fruggr/zendesk-mcp-server/commit/f0e55531dbbfba53c7237d49a371ff0ae0f9f6d6))
</details>

## [2.14.1](https://github.com/fruggr/zendesk-mcp-server/compare/v2.14.0...v2.14.1) (2026-07-19)

### Bug Fixes

* **typecheck:** fall back to JS TypeScript 6 where native tsgo can't run ([#171](https://github.com/fruggr/zendesk-mcp-server/issues/171)) ([7dc1195](https://github.com/fruggr/zendesk-mcp-server/commit/7dc11956e19c89ee157e993da6d451434c19f38b))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **deps:** lock file maintenance ([#168](https://github.com/fruggr/zendesk-mcp-server/issues/168)) ([6fafc94](https://github.com/fruggr/zendesk-mcp-server/commit/6fafc94460edb0b30985fa559fcb5c7b18333eb6))
* **deps:** update dependency typescript to v7 ([#151](https://github.com/fruggr/zendesk-mcp-server/issues/151)) ([2086d17](https://github.com/fruggr/zendesk-mcp-server/commit/2086d1727ba4ef65cff45f33a726fb0605f9ec17))
* **deps:** update pnpm to v11.11.0 ([#167](https://github.com/fruggr/zendesk-mcp-server/issues/167)) ([cb06bad](https://github.com/fruggr/zendesk-mcp-server/commit/cb06bad1d174ffd5ac5451d8a50185e01c139838))
</details>

## [2.14.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.13.0...v2.14.0) (2026-07-17)

### Features

* **help-center:** disambiguate compare_translations status ([#135](https://github.com/fruggr/zendesk-mcp-server/issues/135)) ([#166](https://github.com/fruggr/zendesk-mcp-server/issues/166)) ([5aab8dd](https://github.com/fruggr/zendesk-mcp-server/commit/5aab8dd7a9b78a5cb965ec44527aeaab51c35d0e))

## [2.13.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.12.2...v2.13.0) (2026-07-16)

### Features

* **help_center:** add reorder_article tool ([#159](https://github.com/fruggr/zendesk-mcp-server/issues/159)) ([9b019bf](https://github.com/fruggr/zendesk-mcp-server/commit/9b019bf7c19fc296e5020666cbae21cee47d392a))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **deps:** update @biomejs/biome to v2.5.3 and fix new lint errors ([#165](https://github.com/fruggr/zendesk-mcp-server/issues/165)) ([177362e](https://github.com/fruggr/zendesk-mcp-server/commit/177362e3e0e9ee1cc8a6903c8e12529c4bfcd6f0))
</details>

## [2.12.2](https://github.com/fruggr/zendesk-mcp-server/compare/v2.12.1...v2.12.2) (2026-07-15)

### Bug Fixes

* **help-center:** cap list_content_tags page size at the endpoint limit of 30 ([#164](https://github.com/fruggr/zendesk-mcp-server/issues/164)) ([c999dfd](https://github.com/fruggr/zendesk-mcp-server/commit/c999dfd651b22feefe0045a6bdb51fdd49937c81))

## [2.12.1](https://github.com/fruggr/zendesk-mcp-server/compare/v2.12.0...v2.12.1) (2026-07-15)

### Bug Fixes

* **help-center:** degrade topology gracefully when Guide-admin endpoints 403 ([#163](https://github.com/fruggr/zendesk-mcp-server/issues/163)) ([eb172f2](https://github.com/fruggr/zendesk-mcp-server/commit/eb172f273223511a8bb330f423da08d246929184))

## [2.12.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.11.0...v2.12.0) (2026-07-13)

### Features

* **tickets:** add get_ticket_history for a ticket's change timeline ([#157](https://github.com/fruggr/zendesk-mcp-server/issues/157)) ([69cd8cd](https://github.com/fruggr/zendesk-mcp-server/commit/69cd8cd29fa8605ae3e266dcdca3e06b89e160aa))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Documentation

* require closing keyword to auto-close issues on merge ([#153](https://github.com/fruggr/zendesk-mcp-server/issues/153)) ([ad94712](https://github.com/fruggr/zendesk-mcp-server/commit/ad94712de76a0dc3027c9418e1b2581a62fb9ef7))

### Chores

* add guardrails against duplicate issue work ([#149](https://github.com/fruggr/zendesk-mcp-server/issues/149)) ([b711de2](https://github.com/fruggr/zendesk-mcp-server/commit/b711de27828c93c493d7eb812ee7e9f16216c20f))
* allow in-session tool hot-reload with --dev mode ([#154](https://github.com/fruggr/zendesk-mcp-server/issues/154)) ([99a1cac](https://github.com/fruggr/zendesk-mcp-server/commit/99a1caca61886eaaa0863c15b0586bcf75727ed9))
* **deps:** update pnpm to v11.10.0 ([#148](https://github.com/fruggr/zendesk-mcp-server/issues/148)) ([5cc107a](https://github.com/fruggr/zendesk-mcp-server/commit/5cc107af97becb89802523db5eff4a489560dc7c))
</details>

## [2.11.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.10.0...v2.11.0) (2026-07-11)

### Features

* **tickets:** Views access — list_views + get_view_tickets ([#121](https://github.com/fruggr/zendesk-mcp-server/issues/121)) ([#146](https://github.com/fruggr/zendesk-mcp-server/issues/146)) ([4db7405](https://github.com/fruggr/zendesk-mcp-server/commit/4db7405dea883dc0332fb57e1d747cc0e763c63e))

## [2.10.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.9.0...v2.10.0) (2026-07-11)

### Features

* **tickets:** add list_macros and apply_macro tools ([#120](https://github.com/fruggr/zendesk-mcp-server/issues/120)) ([#145](https://github.com/fruggr/zendesk-mcp-server/issues/145)) ([bd40dc6](https://github.com/fruggr/zendesk-mcp-server/commit/bd40dc640eb33c06ebe944ed69ada31be305e69b))

## [2.9.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.8.0...v2.9.0) (2026-07-10)

### Features

* **tickets:** add read-only list_ticket_fields tool ([#143](https://github.com/fruggr/zendesk-mcp-server/issues/143)) ([4c9563f](https://github.com/fruggr/zendesk-mcp-server/commit/4c9563f836f30f1a5887bb7476261397b8578342))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Documentation

* lead npm description with the differentiator, fit npm snippet budget ([#139](https://github.com/fruggr/zendesk-mcp-server/issues/139)) ([b1673c9](https://github.com/fruggr/zendesk-mcp-server/commit/b1673c99f5c85c2b823c64c074ee5a360b11faf5))

### Chores

* **deps:** lock file maintenance ([#144](https://github.com/fruggr/zendesk-mcp-server/issues/144)) ([86e4660](https://github.com/fruggr/zendesk-mcp-server/commit/86e46609e2e2788d81b0496fa09bee9a651f8053))

### Continuous Integration

* version-control server.json, sync its version at release ([#142](https://github.com/fruggr/zendesk-mcp-server/issues/142)) ([71fd510](https://github.com/fruggr/zendesk-mcp-server/commit/71fd5107a6850e9ae5fa077f04d508af8e1d8e09))
</details>

## [2.8.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.7.0...v2.8.0) (2026-07-08)

### Features

* **help-center:** add archive_article tool ([#133](https://github.com/fruggr/zendesk-mcp-server/issues/133)) ([#136](https://github.com/fruggr/zendesk-mcp-server/issues/136)) ([a23d36e](https://github.com/fruggr/zendesk-mcp-server/commit/a23d36ef9a24945d68c7c1115743bdec37fca995))

## [2.7.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.6.1...v2.7.0) (2026-07-08)

### Features

* **help-center:** paginate and filter list_content_tags ([#132](https://github.com/fruggr/zendesk-mcp-server/issues/132)) ([#137](https://github.com/fruggr/zendesk-mcp-server/issues/137)) ([ae5c7bb](https://github.com/fruggr/zendesk-mcp-server/commit/ae5c7bb6eec8515f1c352eb805a7ee06c65fabb5))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Documentation

* restructure README + extract reference docs + surface multimodal attachments ([#131](https://github.com/fruggr/zendesk-mcp-server/issues/131)) ([d2e17a9](https://github.com/fruggr/zendesk-mcp-server/commit/d2e17a9e6ad0d1bd7ef1bc2f4ab30dbd0c80fda1))

### Chores

* **deps:** update dependency @biomejs/biome to v2.5.2 ([#138](https://github.com/fruggr/zendesk-mcp-server/issues/138)) ([d120906](https://github.com/fruggr/zendesk-mcp-server/commit/d1209066fb7939c44db580bc340370ce260bf782))
</details>

## [2.6.1](https://github.com/fruggr/zendesk-mcp-server/compare/v2.6.0...v2.6.1) (2026-07-05)

### Bug Fixes

* **tools:** state outcomes on article write tools and harden the quality gate ([#130](https://github.com/fruggr/zendesk-mcp-server/issues/130)) ([8e75dfd](https://github.com/fruggr/zendesk-mcp-server/commit/8e75dfd238dc9cc874d1b045e817ff2508fbcc84))

## [2.6.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.5.0...v2.6.0) (2026-07-05)

### Features

* **tools:** sharpen 28 tool definitions so agents call them correctly first time ([#117](https://github.com/fruggr/zendesk-mcp-server/issues/117)) ([40a0c70](https://github.com/fruggr/zendesk-mcp-server/commit/40a0c70cb2e316d737a2a539bf6398a17419c6fb))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Chores

* **coderabbit:** align tool-review rubric with Glama's published TDQS ([#129](https://github.com/fruggr/zendesk-mcp-server/issues/129)) ([e7ab3dd](https://github.com/fruggr/zendesk-mcp-server/commit/e7ab3dd6274e4c4ed9a4dc39bee107b7b8317962))
* **coderabbit:** review src/tools against the Glama quality rubric ([#128](https://github.com/fruggr/zendesk-mcp-server/issues/128)) ([5ae6b40](https://github.com/fruggr/zendesk-mcp-server/commit/5ae6b40ace1e44520fd5bb63224b44b3e93d130b))
* **deps:** lock file maintenance ([#112](https://github.com/fruggr/zendesk-mcp-server/issues/112)) ([b2a4db3](https://github.com/fruggr/zendesk-mcp-server/commit/b2a4db3d785019df09dce7219a03ec1948b945c4))
</details>

## [2.5.0](https://github.com/fruggr/zendesk-mcp-server/compare/v2.4.0...v2.5.0) (2026-07-02)

### Features

* **tickets:** attach files to comments and notes via the Uploads API ([#110](https://github.com/fruggr/zendesk-mcp-server/issues/110)) ([5865835](https://github.com/fruggr/zendesk-mcp-server/commit/586583559123dee2d3c3639e174e06a33246e0d1))

<details>
<summary>🔧 Internal changes (chore, ci, build, refactor, tests, docs…)</summary>

### Documentation

* **agents:** spell out the Glama criteria and no-regression rule for tools ([#111](https://github.com/fruggr/zendesk-mcp-server/issues/111)) ([aa8164c](https://github.com/fruggr/zendesk-mcp-server/commit/aa8164c8293fab79466e02ddf23399092f9284f2))
* feature-oriented descriptions (registry, npm, README) ([#109](https://github.com/fruggr/zendesk-mcp-server/issues/109)) ([0354afc](https://github.com/fruggr/zendesk-mcp-server/commit/0354afc42f3808b4131cb5139a3fb5d5ac090133))

### Chores

* **deps:** update pnpm to v11.9.0 ([#108](https://github.com/fruggr/zendesk-mcp-server/issues/108)) ([41e69aa](https://github.com/fruggr/zendesk-mcp-server/commit/41e69aaaf1607a8d76f16fb3aba2e0f0ff848910))
</details>

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
