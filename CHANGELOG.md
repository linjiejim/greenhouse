# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0](https://github.com/linjiejim/greenhouse/compare/v1.3.2...v1.4.0) (2026-10-10)


### Added

* **agent-core:** move to AI SDK 7 ([f8e5778](https://github.com/linjiejim/greenhouse/commit/f8e5778a7d762df30f46b145646f973e236f802e))
* **agent-core:** one loop assembly for chat and every headless run ([bc7f935](https://github.com/linjiejim/greenhouse/commit/bc7f93510f0e4ba655829e0d9c903a6e65aa8f4e))
* **agent-core:** report headless step progress ([4251c1b](https://github.com/linjiejim/greenhouse/commit/4251c1b124ade39f40c67a59028a36551ea7f981))
* **api:** an account's language follows the app until the member picks one ([ab75d3c](https://github.com/linjiejim/greenhouse/commit/ab75d3cd52fd0e19ad6cd33962df9801f84ae71b))
* **api:** list sessions with one Bot (`GET /api/sessions?profile=`) ([e24db1b](https://github.com/linjiejim/greenhouse/commit/e24db1b159ae424e85f87698903fb3071aed4d1b))
* **avatars:** a Bot's colour, and faces that follow state ([da73197](https://github.com/linjiejim/greenhouse/commit/da73197df8489d9e79451a3821113886902dec9c))
* **bots:** Bot computers can run as hosted E2B sandboxes ([#52](https://github.com/linjiejim/greenhouse/issues/52)) ([3e7dd6c](https://github.com/linjiejim/greenhouse/commit/3e7dd6ca6ac7fb15c1da7fdc4a0e6feb56ccd395))
* **bots:** computers on from Runtime Config, vault key rotation, live CI ([#57](https://github.com/linjiejim/greenhouse/issues/57)) ([bab1140](https://github.com/linjiejim/greenhouse/commit/bab1140a9e61d8d73603eb050dbbadc71c2e89b2))
* **bots:** converge agent profiles into private Bot identities ([#40](https://github.com/linjiejim/greenhouse/issues/40)) ([09d4a00](https://github.com/linjiejim/greenhouse/commit/09d4a0057e2d1134028b37f2ec618303032832a1))
* **bots:** count unread Bot replies per conversation ([3b372b8](https://github.com/linjiejim/greenhouse/commit/3b372b86e1cf03678608f5436d13cfb35804389b))
* **bots:** encrypted home backups — restore lost computers, move between providers ([#59](https://github.com/linjiejim/greenhouse/issues/59)) ([8fdaab1](https://github.com/linjiejim/greenhouse/commit/8fdaab16d7bcf1be49b0e115530a9276471e9f53))
* **bots:** keep hosted computers' member accounts off metadata and internal networks ([#61](https://github.com/linjiejim/greenhouse/issues/61)) ([1f095a7](https://github.com/linjiejim/greenhouse/commit/1f095a7cfb71a440185033e2436d7ea0f2ad4098))
* **bots:** personal assistants with computers, vault and conversations ([#38](https://github.com/linjiejim/greenhouse/issues/38)) ([1cf1f5b](https://github.com/linjiejim/greenhouse/commit/1cf1f5b29bcb709954e5f49a8b6ceffadaa14d6f))
* **bots:** previews, process wake-ups and readable long pages for Bot computers ([#55](https://github.com/linjiejim/greenhouse/issues/55)) ([f73cce8](https://github.com/linjiejim/greenhouse/commit/f73cce864f473aab035ad4d8bbcb8c464895b260))
* **bots:** retire group chats — Bots bring each other into a DM ([61d8ecc](https://github.com/linjiejim/greenhouse/commit/61d8ecc76342c0d8edbf5caa52f35bbde9383fdb))
* **bots:** short greetings, concise-but-proactive replies, readable approval cards ([e6727c9](https://github.com/linjiejim/greenhouse/commit/e6727c9bb718f19217e6ecb03136669b46e89a3c))
* **bots:** three example Bots that need no computer ([212ecbb](https://github.com/linjiejim/greenhouse/commit/212ecbbb1d6b19a94058e207a595d16f761eb13e))
* **brand:** adopt Haven identity and Nunito across clients ([#42](https://github.com/linjiejim/greenhouse/issues/42)) ([333d193](https://github.com/linjiejim/greenhouse/commit/333d193790e48111c9a569d2e9c0b990ab4b8b69))
* **chat:** mask earlier tool results in a long turn ([efa916b](https://github.com/linjiejim/greenhouse/commit/efa916b08e8db84e30920c2cc887cbeb9d903586))
* **deploy:** one-click install, Railway, and a first admin without exec ([#49](https://github.com/linjiejim/greenhouse/issues/49)) ([2bc5993](https://github.com/linjiejim/greenhouse/commit/2bc5993ae6db74db1cf352c077730809f1253658))
* **eval:** an agent scenario bank, and ground truth that never breaks a run ([d0f7ca9](https://github.com/linjiejim/greenhouse/commit/d0f7ca928c8f44af0852f789ee4058de303bb0ec))
* **feishu:** a live "processing" card and dedup across re-sent message ids ([e4cb92e](https://github.com/linjiejim/greenhouse/commit/e4cb92ec8b66da7d8ceb4ccdfa149baf9557bffb))
* **mcp:** annotate read-only tools on the MCP server ([c987948](https://github.com/linjiejim/greenhouse/commit/c98794821e8d928fa6144c16c255d0d4b9c6450a))
* **mcp:** call tools on external MCP servers from chat ([af72ae0](https://github.com/linjiejim/greenhouse/commit/af72ae0e043d79a676a91c93bd595912ee418fbe))
* **mcp:** connectors — each member's own key or sign-in, Bots, official catalog ([06b0c77](https://github.com/linjiejim/greenhouse/commit/06b0c7728f9100f51efd74a1891d328c1b0cae57))
* **memory:** ranked recall, a cache-stable index, undiluted merges ([438c618](https://github.com/linjiejim/greenhouse/commit/438c61845466fcb2144ea1ccdec5113f12043558))
* mobile push notifications — a Bot needs you, work is done, replies after you left ([#56](https://github.com/linjiejim/greenhouse/issues/56)) ([e625bb3](https://github.com/linjiejim/greenhouse/commit/e625bb323d61a8711334271249f31716a8444d86))
* **mobile:** a Bot's background task as a Live Activity (experimental) ([#60](https://github.com/linjiejim/greenhouse/issues/60)) ([8ede57e](https://github.com/linjiejim/greenhouse/commit/8ede57ef3c9c84512bd1b13ed2156e1bc9e20abc))
* **mobile:** a Bot's profile gathers everything about it; make Bots in My Bots ([d12c8a4](https://github.com/linjiejim/greenhouse/commit/d12c8a4b1e1d6f5edb53e3e2a09d2b12fced8fb9))
* **mobile:** a colour row instead of a mood in the Bot form ([4e7ed5d](https://github.com/linjiejim/greenhouse/commit/4e7ed5d3b4a872bc937510deed6ae53112e1414b))
* **mobile:** a hand-off opens its whole brief in a sheet ([3cfadfc](https://github.com/linjiejim/greenhouse/commit/3cfadfc5351daf741c77c9506f9c125faee1750e))
* **mobile:** a reply stays quiet until it has something to show ([c2992c2](https://github.com/linjiejim/greenhouse/commit/c2992c21dbc39e3cfc5f5b9e9bbd4cef696a00e4))
* **mobile:** avatars that blink, glance and talk, with a face for every state ([908e934](https://github.com/linjiejim/greenhouse/commit/908e934dc0365c3cd840f692e43aa740cdb538cc))
* **mobile:** Bots foundation — contracts, vendored web logic, API client, store, routes ([6a25b81](https://github.com/linjiejim/greenhouse/commit/6a25b81490da78162b79dc39ba79256591717504))
* **mobile:** Bots in the drawer and home ([25cbb89](https://github.com/linjiejim/greenhouse/commit/25cbb89b8952dfa886fab1adb25a2b3f57874683))
* **mobile:** Bots request cards and needs-you ([5276804](https://github.com/linjiejim/greenhouse/commit/5276804eae720aca5721682619d8d8103d4c99ff))
* **mobile:** Bots thread engine and realtime ([0d9038d](https://github.com/linjiejim/greenhouse/commit/0d9038d339ebe189eb656acf7c6e8c0b9a71cd7a))
* **mobile:** Bots thread screen ([e42c6d7](https://github.com/linjiejim/greenhouse/commit/e42c6d7ae23545ecec72615df7a18b320e8cda79))
* **mobile:** calmer chat and Bots threads ([5b7026e](https://github.com/linjiejim/greenhouse/commit/5b7026e32999c692bae7183b4f55d169924cfb7f))
* **mobile:** charts by Swift Charts; the HTML card opens its page ([c0696cb](https://github.com/linjiejim/greenhouse/commit/c0696cb28988955537c9148651cdf7a2cc15100a))
* **mobile:** connectors — connect your own account from Settings or the chat ([c24fec8](https://github.com/linjiejim/greenhouse/commit/c24fec8a95626b31fa1af56e0cf499204bf68806))
* **mobile:** drawer — Knowledge and Projects at the bottom, hairlines between Bots ([7304418](https://github.com/linjiejim/greenhouse/commit/730441896f54ab786c4df5bbb3a71784c0ae3549))
* **mobile:** keep the account language in step with the app's ([d86a31e](https://github.com/linjiejim/greenhouse/commit/d86a31e3b36b71e4e1e24532b86bdee6863a8a15))
* **mobile:** manage Bots and groups on mobile ([d5b02e8](https://github.com/linjiejim/greenhouse/commit/d5b02e8c7990f4a643117d355e9e62825e085f62))
* **mobile:** native iOS rewrite on Expo SDK 57 ([#37](https://github.com/linjiejim/greenhouse/issues/37)) ([8d8d9d1](https://github.com/linjiejim/greenhouse/commit/8d8d9d1641945699b1ed0fc1b93fbf9a4f76cac0))
* **mobile:** new chats start with Sprouty; a splash that plays in full ([01537e1](https://github.com/linjiejim/greenhouse/commit/01537e103fa101f88098b8ad574439fc17c27b4a))
* **mobile:** no agent picker above the new chat's composer ([49f23c6](https://github.com/linjiejim/greenhouse/commit/49f23c6912593b6f817603f06bc1900c3e372725))
* **mobile:** pick a Bot's connectors on the phone ([0333838](https://github.com/linjiejim/greenhouse/commit/03338384b3abf74ca21d358e236e649de7399112))
* **mobile:** retire group chats on the phone ([88fd466](https://github.com/linjiejim/greenhouse/commit/88fd466841f1f53fdf33181af9a9db97531d094b))
* **mobile:** the account takes the app's language until the member picks one ([4e8835a](https://github.com/linjiejim/greenhouse/commit/4e8835ade0d28c7c8fc9eb1937c9b87414c741fc))
* **mobile:** the drawer shows today and pinned, folds the rest, keeps apps in a bar ([5066a1c](https://github.com/linjiejim/greenhouse/commit/5066a1cdfc3c99951a95f7ea1cf35f37642376bc))
* **mobile:** the home-screen widget lines up your Bots ([8c1176f](https://github.com/linjiejim/greenhouse/commit/8c1176fad10faaacc42b5d4d32f05deabafb6dd8))
* **rich-output:** stats/cards/steps blocks, reply buttons, per-screen capabilities ([#43](https://github.com/linjiejim/greenhouse/issues/43)) ([928c72d](https://github.com/linjiejim/greenhouse/commit/928c72df394d7d17e65730c7034a117d72d5f91c))
* **web:** connectors — install from the catalog, connect your own account ([1550fd4](https://github.com/linjiejim/greenhouse/commit/1550fd4b6eb7c0ac78055b8944920545e39c3760))
* **web:** pick a Bot's colour instead of a mood ([3939d58](https://github.com/linjiejim/greenhouse/commit/3939d5850261e9694c58f263d9729d78fe724c3d))
* **web:** retire group chats in the Bots UI ([b0893d2](https://github.com/linjiejim/greenhouse/commit/b0893d22ecf1a9b3101ede5cf1f5ffc9599413dc))


### Fixed

* **agent-core:** catch the `<｜｜DSML｜｜ calls>` leak variant ([78c45ce](https://github.com/linjiejim/greenhouse/commit/78c45ce22ed72d5af225050d762cb16cb31537e8))
* **agent-core:** don't send a temperature DeepSeek ignores while thinking ([e5d14f5](https://github.com/linjiejim/greenhouse/commit/e5d14f5270ca5ad8429dd9e3bdaf0edcee6c1e8e))
* **agent-core:** headless runs pass only the timeouts generateText honours ([f539bbc](https://github.com/linjiejim/greenhouse/commit/f539bbc149958f5e381f425b69cebeb43aac5c0f))
* **api:** a refused connector key keeps its reason apart; the model points at the card ([c3caeb6](https://github.com/linjiejim/greenhouse/commit/c3caeb695f4ad0703acb6121dba77593661f987e))
* **api:** keep the API up when a database blip hits a WebSocket connect ([0f88660](https://github.com/linjiejim/greenhouse/commit/0f88660560e052cc520d2b109e5ad4488ad4f92f))
* **bots:** a card sits under the reply of the turn that raised it ([a0da0ae](https://github.com/linjiejim/greenhouse/commit/a0da0aed0f4d4ee61161c0b9ca76fbcf47581f4d))
* **bots:** an approval card's values read in the member's words ([834d02c](https://github.com/linjiejim/greenhouse/commit/834d02c74a22fee431ecd6810f1ba7fc6c468236))
* **bots:** approval questions no longer repeat the Bot's name ([3a5952b](https://github.com/linjiejim/greenhouse/commit/3a5952bcd5c846915816caa607a06a569a22e712))
* **bots:** hosted computers survive memory hogs and failed home moves ([#54](https://github.com/linjiejim/greenhouse/issues/54)) ([37cd185](https://github.com/linjiejim/greenhouse/commit/37cd18522dadfb3d2b79d654423b947bba546c7c))
* **chat:** on cheap-cache models, mask tool results only when the window needs it ([ce3df49](https://github.com/linjiejim/greenhouse/commit/ce3df49c500db36480d7e153f8e0d71660810e00))
* **feishu:** a reply in the chain carries the conversation to the model ([d4fc9bd](https://github.com/linjiejim/greenhouse/commit/d4fc9bdecaf6505592eb87bd946d280868bdb14e))
* **mcp:** a connector nobody has connected is offered right after install ([f383346](https://github.com/linjiejim/greenhouse/commit/f3833469320914cdd78225d6f229d169260a809c))
* **mobile:** a Bots thread holds still while it replies; cards open to decide ([90cfccb](https://github.com/linjiejim/greenhouse/commit/90cfccb8ba10ed1655d6f159cde4f792b414133a))
* **mobile:** a conversation that loads empty greets like a new one ([fca4b75](https://github.com/linjiejim/greenhouse/commit/fca4b75149fda388d0d5a9c905e5d3ef796320f7))
* **mobile:** Bots copy and layout that hold in English and Chinese ([b94ab61](https://github.com/linjiejim/greenhouse/commit/b94ab61986dfd3f9e1c19ce99590df162670a9e8))
* **mobile:** composer hints stay on one line beside Stop ([b6252bf](https://github.com/linjiejim/greenhouse/commit/b6252bf191cf42ea57e9fae93fdaa8ba763dc41c))
* **mobile:** connector refusals in words, the raw answer behind 详情 ([f5c8774](https://github.com/linjiejim/greenhouse/commit/f5c8774d7f71eeeb0d730d184f29b777d3bb63e5))
* **mobile:** gate Bots deep links and fix New Chat from an Ask-a-Bot screen ([8ab6515](https://github.com/linjiejim/greenhouse/commit/8ab651518717795012a2bb5ba62f262f86c75017))
* **mobile:** half-height sheets fade at their bottom edge; New Bot opens full height ([6e1e49c](https://github.com/linjiejim/greenhouse/commit/6e1e49c082ae8501183076333d9b5920aa21cd4d))
* **mobile:** integrate Bots packages ([1b93c0a](https://github.com/linjiejim/greenhouse/commit/1b93c0ad97f415e2695fb730e55b1aac5cf5b2c9))
* **mobile:** keep a Bots reply in view after a keyboard-up send ([32c1bb8](https://github.com/linjiejim/greenhouse/commit/32c1bb8f2d344b06dc4fc3fe0495218362847ca3))
* **mobile:** keep Bots sheet forms clear of the nav bar ([3384a4b](https://github.com/linjiejim/greenhouse/commit/3384a4b047f247d48277e61667043eb636cfff15))
* **mobile:** keep Bots thread anchors, highlights and tap targets reliable ([2117c94](https://github.com/linjiejim/greenhouse/commit/2117c9435f21d76b75cb50d17526811a92bc4b02))
* **mobile:** keep Bots transcripts whole and busy state accurate ([aba6aa1](https://github.com/linjiejim/greenhouse/commit/aba6aa155c5dd243d2efe5eb8e4141ab268d1cc7))
* **mobile:** make Bots forms and cards work with VoiceOver and large text ([9f5b1d2](https://github.com/linjiejim/greenhouse/commit/9f5b1d2a0c553418931a673a545005a391372a56))
* **mobile:** never send one station's token to another station's address ([cd51be6](https://github.com/linjiejim/greenhouse/commit/cd51be6a4428a6eb38bf8cc4602c3948a39d8f2f))
* **mobile:** New Chat leaves a thread restored on a cold start ([dfae23a](https://github.com/linjiejim/greenhouse/commit/dfae23a2ba236692ed281d66e98c02e6f5f7f075))
* **mobile:** no "Save Password?" or crash when a Bots sign-in sheet closes ([1f448f8](https://github.com/linjiejim/greenhouse/commit/1f448f82cac81f40fd5bd2f64fa75fc56f7fec42))
* **mobile:** only send the token with this station's chat files; steady Bots sign-in ([9ecc142](https://github.com/linjiejim/greenhouse/commit/9ecc142243079f62a4afc65753adff1edcca3b44))
* **mobile:** reflow mounted text when the system text size changes ([ac2ddb7](https://github.com/linjiejim/greenhouse/commit/ac2ddb7c1437f1c5bf2bfc0e22b84e0031161d99))
* **mobile:** send tokens and refreshes only to the active station ([5521a5a](https://github.com/linjiejim/greenhouse/commit/5521a5aa0be5585f28d428dad705c5ed18bbda3d))
* **mobile:** steadier Bots sheets and cards ([47a82d2](https://github.com/linjiejim/greenhouse/commit/47a82d2a314b66c8246dc359bcbd68b6fd780c21))
* **rich-output:** harden the html-preview bridge and close the [#43](https://github.com/linjiejim/greenhouse/issues/43) review notes ([#45](https://github.com/linjiejim/greenhouse/issues/45)) ([bccb2fc](https://github.com/linjiejim/greenhouse/commit/bccb2fc4c20c8ce4256ef7276ff1681885c2e7e8))
* **web:** sanitize exported answers and sandbox the PDF print frame ([#44](https://github.com/linjiejim/greenhouse/issues/44)) ([e544c09](https://github.com/linjiejim/greenhouse/commit/e544c099a6872ff76d39069f20265df80b011c08))
* **web:** show which external tool an MCP call reached ([dd02189](https://github.com/linjiejim/greenhouse/commit/dd02189684f3ed50347c95620f648be1aa00da95))
* **web:** the OAuth consent screen no longer re-renders forever ([48588f0](https://github.com/linjiejim/greenhouse/commit/48588f0bb653bbbb74debdb86f5b0b8bedfef01b))


### Changed

* **mobile:** drop the cross-conversation capsule, the home bridge and the Bot shelf ([cd92d7b](https://github.com/linjiejim/greenhouse/commit/cd92d7ba6628271a3d7fc027c66e88bfe3bc0c9d))

## [1.3.2](https://github.com/linjiejim/greenhouse/compare/v1.3.1...v1.3.2) (2026-09-24)


### Changed

* **api:** keep the chat route off the tool catalog ([#34](https://github.com/linjiejim/greenhouse/issues/34)) ([9163ba0](https://github.com/linjiejim/greenhouse/commit/9163ba0a065bdbb9de7ce37d568ff73613fccc94))

## [1.3.1](https://github.com/linjiejim/greenhouse/compare/v1.3.0...v1.3.1) (2026-09-24)


### Fixed

* **browser:** put the extension back on the current chat contract ([#30](https://github.com/linjiejim/greenhouse/issues/30)) ([7bfb3a5](https://github.com/linjiejim/greenhouse/commit/7bfb3a5b2573b58eadf453a85f1ec0e74aaddb39))

## [1.3.0](https://github.com/linjiejim/greenhouse/compare/v1.2.0...v1.3.0) (2026-09-23)


### Added

* **media:** image generation can use its own endpoint (IMAGE_BASE_URL + IMAGE_API_KEY) ([6010590](https://github.com/linjiejim/greenhouse/commit/601059045fbbbfcc9389b8ccdafa822ff3098d01))
* **models:** DeepSeek-only catalog; the default model reads attached images ([844ef94](https://github.com/linjiejim/greenhouse/commit/844ef949ae5c0a18c0d4f6d03b3349d9c603d45d))


### Fixed

* **chat:** run a retired or unkeyed model choice on the default instead of failing ([72e7a48](https://github.com/linjiejim/greenhouse/commit/72e7a483a850ed55c7a0e71857b55d7104ac84a8))
* **desktop:** ignore Apple signing variables a CI runner left empty ([19d2d5e](https://github.com/linjiejim/greenhouse/commit/19d2d5e102fcd5710576ebdcc2310e191c569708))
* **web:** the Agent editor shows and saves the default for a retired model ([54ad249](https://github.com/linjiejim/greenhouse/commit/54ad249e8dbba3ef270abaa9789a154823403cc0))

## [1.2.0](https://github.com/linjiejim/greenhouse/compare/v1.1.0...v1.2.0) (2026-09-16)


### Added

* **desktop:** Tauri desktop shell with signed hot updates, configured per deployment by environment ([da114c9](https://github.com/linjiejim/greenhouse/commit/da114c9d8e9a9adade82574487997fabddcc7641))


### Fixed

* **agent-core:** build DeepSeek-backed openai-compatible entries with the DeepSeek client ([15bcb3f](https://github.com/linjiejim/greenhouse/commit/15bcb3f780915eb786d055e01a1ed979e9f7acf5))
* **desktop:** pass the Tauri config overlay as a file, not inline JSON ([86bf439](https://github.com/linjiejim/greenhouse/commit/86bf439aafb1b38a92d066c0d99c622736b7a23c))

## [1.1.0](https://github.com/linjiejim/greenhouse/compare/v1.0.0...v1.1.0) (2026-09-15)


### Added

* **web:** extension page aliases replace the hard-coded legacy redirects ([e6c89dd](https://github.com/linjiejim/greenhouse/commit/e6c89dd4ac7e4115f623a3ab7afb154646f29fc6))


### Fixed

* **extensions:** refuse a tool core could never build; hand lazy tools the unattended flag ([4d3364c](https://github.com/linjiejim/greenhouse/commit/4d3364c7d6b3f2cf92cff544d12cd873567b4a66))
* **mission:** hand the relay's per-model output caps to the sandbox runner ([acd4914](https://github.com/linjiejim/greenhouse/commit/acd49149f12b50347f573f1f2d2572d5fc58ac83))
* **mission:** stop retrying containment when there is no docker CLI at all ([d9676ed](https://github.com/linjiejim/greenhouse/commit/d9676edb4797dde0be0c0d514efe333920808c8b))
* **web:** give extension administration modules core's `admin.<key>` id ([399222b](https://github.com/linjiejim/greenhouse/commit/399222ba69a5376683fadb2492cc20db4c2efd79))

## [1.0.0](https://github.com/linjiejim/greenhouse/compare/v0.6.0...v1.0.0) (2026-09-14)


### ⚠ BREAKING CHANGES

* **db:** the public /api/v1 surface, guest accounts and the database-managed LLM gateway upstreams are removed; models come from apps/api/src/config/models.yaml.

### Added

* **agent-core:** env-derived registry, provider quirks and run guarantees ([3e59338](https://github.com/linjiejim/greenhouse/commit/3e593389f87286f9d9e56822897629ac46b1c11c))
* **agent-runner:** mission sandbox runner image ([722ae65](https://github.com/linjiejim/greenhouse/commit/722ae6558aeb1eb916df91985cce5265438eeebf))
* **api:** extension seam — one object per extension, aggregated into every registry ([38182a4](https://github.com/linjiejim/greenhouse/commit/38182a4b73870a5c8c8bb03c9b44e3e9085c877c))
* **api:** platform kernel host, tables, runtime kernel, missions and integrations ([6d38b37](https://github.com/linjiejim/greenhouse/commit/6d38b3771d2a99610e2deaf483da4a5ee6234089))
* **cli:** db baseline --through stops short of the end of a chain ([cb3ef52](https://github.com/linjiejim/greenhouse/commit/cb3ef5284b5b778f9c52aa0c91d5a2b4862098ac))
* **cli:** db baseline refuses to record migrations whose tables are absent ([3a7e24b](https://github.com/linjiejim/greenhouse/commit/3a7e24bd62abe13dbf7b5a5d8e07fd0d6c111c38))
* **clients:** typed station config with a single-station lock ([a5162be](https://github.com/linjiejim/greenhouse/commit/a5162be4efcef2e0bfb45be167796257241301bf))
* **config:** typed greenhouse.config.ts, validated at boot ([364d004](https://github.com/linjiejim/greenhouse/commit/364d004adab26ad34812cb30a54b4a5770c80c77))
* **crud,ui,knowledge-editor:** interaction standard and editor updates ([33b8fa2](https://github.com/linjiejim/greenhouse/commit/33b8fa25115a63e21217f339bf4e497c482e1af2))
* **db:** extension services, reset tables and a checksummed migration lane ([295275c](https://github.com/linjiejim/greenhouse/commit/295275c8e094661adb93ff0e215560e65947a240))
* **db:** platform-line schema, services and migration 0006 ([9ecd463](https://github.com/linjiejim/greenhouse/commit/9ecd46398570d5de32977973b30db474f9ed7112))
* **drive:** extensions can own a drive scope ([3a3cc04](https://github.com/linjiejim/greenhouse/commit/3a3cc0443be429da484715859e46f231bd795654))
* **extensions:** declare a dependency on another extension ([a2458a3](https://github.com/linjiejim/greenhouse/commit/a2458a3c63f9dd595b25350c755c2a5aa0c68b68))
* **extensions:** export sources and application-backed tool visibility ([a7508cf](https://github.com/linjiejim/greenhouse/commit/a7508cf2bc95ec551cbfe78df51e066b83f45d19))
* **extensions:** open the last four shared registries — record kinds, search, MCP groups, workbench cards ([80d299b](https://github.com/linjiejim/greenhouse/commit/80d299bd688ed925926a4b4bf2a71b70c333f789))
* **platform-kernel:** manifest v2, actor context, authorization and registry ([f00c371](https://github.com/linjiejim/greenhouse/commit/f00c371466c62c6d400b5fe266da5fac9d05f9b9))
* **platform:** applications declare which entities the team role may export ([aa058f1](https://github.com/linjiejim/greenhouse/commit/aa058f159ebae6352293c8881258cbd0a5bcc9a0))
* **scripts:** screenshot tour that doubles as a browser smoke test ([7f863fa](https://github.com/linjiejim/greenhouse/commit/7f863fae216f685cb6e43d296e25515a3c009f7a))
* **skills:** first-party skill pack directory and sync script ([e773f66](https://github.com/linjiejim/greenhouse/commit/e773f66da558a86cdf750e4915aa13948a9a9d9e))
* **types,utils:** shared registries and helpers for the platform line ([2e22e7c](https://github.com/linjiejim/greenhouse/commit/2e22e7c625995e448cfa9c43f2bbce07a1a78625))
* **web:** extension pages can declare their own sub-modules ([5821770](https://github.com/linjiejim/greenhouse/commit/58217705a4ff7b91a5fe927133d374c31b3648d6))
* **web:** extension seam — pages, navigation, modules, copy, cards and agent context ([8ab9224](https://github.com/linjiejim/greenhouse/commit/8ab92243a2c5178745c082ad06dc0e7cc5004411))
* **web:** platform catalog shell, tables, execution center and chat upgrades ([3089011](https://github.com/linjiejim/greenhouse/commit/30890118c1873ddd2d87ee68ba12b4a96b13d570))


### Fixed

* **agent-core:** guarantee a final assistant answer when tool loops end with no text ([#21](https://github.com/linjiejim/greenhouse/issues/21)) ([14ff075](https://github.com/linjiejim/greenhouse/commit/14ff0750dd314ac977d91e8480580e363f17c5a6))
* **build:** the web build failed in a clean environment ([f56a607](https://github.com/linjiejim/greenhouse/commit/f56a6073d66b3a08dbd1207aa3ef4af6800b4c4b))
* **cli:** baseline's table check has to net creates against later drops ([77d8222](https://github.com/linjiejim/greenhouse/commit/77d8222b7a73c32cb54ea4393e2552ed3f10a8be))
* **cli:** db baseline took its confirmation arguments in the wrong order ([5b2322f](https://github.com/linjiejim/greenhouse/commit/5b2322f927d87867c1330aeff9c83bc0b95134bb))
* **drive:** folder creation dropped the extension owner key ([436d2cf](https://github.com/linjiejim/greenhouse/commit/436d2cf4b343afa7fbd95cbac5541e260e6328bb))
* **extensions:** type userRole on the search and drive seam contexts ([d1a7a6b](https://github.com/linjiejim/greenhouse/commit/d1a7a6bb74f59deaaa9c896d400ff15b9d38c9ff))
* **lint:** pin the typescript-eslint project root ([90d04e4](https://github.com/linjiejim/greenhouse/commit/90d04e45973e76194d1344ff3820a6225d12c1f7))
* **platform:** derive application gating from the feature-point registry ([d3b13af](https://github.com/linjiejim/greenhouse/commit/d3b13afe916ccebcca7fd47ceb041e12bc85b2be))
* remove the strings, helpers and navigation left behind by the private modules ([865af69](https://github.com/linjiejim/greenhouse/commit/865af697dc9f1565c84a901148b5409bd9b14d32))
* **scripts:** the overlay guard's ** only matched one directory level ([aa28f08](https://github.com/linjiejim/greenhouse/commit/aa28f0865aa7df5550cbf9c4bc2fe4adb1e8ab30))
* **seed:** drop the retired read_at field from session shares ([d0f4f8d](https://github.com/linjiejim/greenhouse/commit/d0f4f8d37dd868d5451410ffcaf448e63635a924))
* **web:** keep chat header actions clear of the title on phones ([58d6a7f](https://github.com/linjiejim/greenhouse/commit/58d6a7f7a01be2f03d9b679cc94358c3ad677977))
* **web:** localized automation times, plain-text inbox previews, wrapping MCP scopes ([1f35dbf](https://github.com/linjiejim/greenhouse/commit/1f35dbfb4522abe29169fa036e0e9368b40cca6a))


### Changed

* **api:** group the flat domain files into chat/, knowledge/, profiles/, security/, sessions/ and drive/ ([d6edeb4](https://github.com/linjiejim/greenhouse/commit/d6edeb43206f4e55eaf8c03c32b5872b0ca18d1a))
* release 1.0.0 ([91f7850](https://github.com/linjiejim/greenhouse/commit/91f78509824c40673e569c5a7ca5afe44845d942))
* **tests:** move the loose test files under tests/api and refresh doc paths ([fede0fa](https://github.com/linjiejim/greenhouse/commit/fede0fa1e785190a58e61d49cdc2e3010ed3942a))
* **web:** administration panels under pages/administration, executions/ and top-level tasks/automations ([2a841e9](https://github.com/linjiejim/greenhouse/commit/2a841e9c1bfc24d2b2aaea6a8a2d253c3d6d6668))

## [0.6.0](https://github.com/linjiejim/greenhouse/compare/v0.5.0...v0.6.0) (2026-07-09)


### Added

* **crud:** unify settings admin pages on @greenhouse/crud ([#18](https://github.com/linjiejim/greenhouse/issues/18)) ([b207c1b](https://github.com/linjiejim/greenhouse/commit/b207c1b916d6db35050a813a1553f5eeba556fb5))
* **workspace:** admin-editable branding, runtime keys & Sprouty DSL ([#11](https://github.com/linjiejim/greenhouse/issues/11)) ([80b5b3e](https://github.com/linjiejim/greenhouse/commit/80b5b3ebbb86e3b3b90b4dbd238149285e66fe14))


### Fixed

* **db:** bump renumbered workspace_settings migration timestamp so migrated databases apply it ([7093c70](https://github.com/linjiejim/greenhouse/commit/7093c70c21f7971e6f9d042f056b90711d1ce083))

## [0.5.0](https://github.com/linjiejim/greenhouse/compare/v0.4.0...v0.5.0) (2026-07-08)


### Added

* **mobile:knowledge:** native editing, version history, scope tabs ([0a33de6](https://github.com/linjiejim/greenhouse/commit/0a33de61f4b026bc5cd69caa20ae1811daa23041))
* **mobile:projects:** project management — list, board, touch-native gantt ([#16](https://github.com/linjiejim/greenhouse/issues/16)) ([e57fbf9](https://github.com/linjiejim/greenhouse/commit/e57fbf9e774b3b5183fef87fa6b261b2a3e864c3))


### Fixed

* **mobile:sheet:** never let the keyboard push sheets off-screen ([31b5e3e](https://github.com/linjiejim/greenhouse/commit/31b5e3e569c4958bf58da2beac3e030c942e51a2))

## [0.4.0](https://github.com/linjiejim/greenhouse/compare/v0.3.0...v0.4.0) (2026-07-08)


### Added

* **mobile:** app icon — greenhouse logo (iOS + Android adaptive) ([0bd11dc](https://github.com/linjiejim/greenhouse/commit/0bd11dc67abb0b9d236eb4c3d3319a6969eb3640))
* **mobile:** chat & nav polish — smooth stream reveal, one-row composer, station switcher in drawer ([ff49924](https://github.com/linjiejim/greenhouse/commit/ff4992427a96a00f5658e6161591fe52202e14f5))

## [0.3.0](https://github.com/linjiejim/greenhouse/compare/v0.2.0...v0.3.0) (2026-07-07)


### Added

* **api&web:skills:** add Skill Center for skill sharing & sync ([3cbcccb](https://github.com/linjiejim/greenhouse/commit/3cbcccbf6fd7075ddc4b4fdeea13f3fc09e00470))
* **browser&mobile:stations:** connect to multiple self-hosted servers ([a196615](https://github.com/linjiejim/greenhouse/commit/a196615cd44bb38dce94f0b1b4ac13eaa7fa91be))
* **release:** mobile fingerprint CD + pull-based GHCR compose upgrade ([6188c45](https://github.com/linjiejim/greenhouse/commit/6188c45f932a39302333249b5f65fc9243dfb5d3))


### Fixed

* **ci:** pin continuous-deploy-fingerprint to a main sha ([266117a](https://github.com/linjiejim/greenhouse/commit/266117af52a3544e830758f44eae4dcbadd4dace))
* **ci:** submit new mobile store builds to TestFlight explicitly ([dd1f52e](https://github.com/linjiejim/greenhouse/commit/dd1f52e874021fdcfe01eb6438078f500c7e5666))
* **mobile:** pin ascAppId so --auto-submit resolves non-interactively ([04e7635](https://github.com/linjiejim/greenhouse/commit/04e76350620b2ba83b6aba0782e5dcde7819fb09))

## [0.2.0](https://github.com/linjiejim/greenhouse/compare/v0.1.0...v0.2.0) (2026-07-06)


### Added

* **release:** standardize release pipeline with version automation, container images, browser packaging, and mobile EAS ([93c295a](https://github.com/linjiejim/greenhouse/commit/93c295a672501b4b7e04c0590f4dca71bbfda436))

## [Unreleased]

> From here on, this changelog is maintained by [release-please](https://github.com/googleapis/release-please)
> from Conventional Commits. See [RELEASING.md](./RELEASING.md).

### Added

- Release engineering: automated versioning via release-please (Release PR → tag →
  GitHub Release), and a tag-triggered `release.yml` that publishes the container
  image to GHCR (`:X.Y.Z`/`:X.Y`/`:latest` for stable; `:edge`/`:main-<sha>` for
  `main`) and attaches the browser extension zip to the Release.
- `RELEASING.md` maintainer runbook; README "Releases & stability" section + latest-release
  badge; `SECURITY.md` supported-versions table.
- Build version stamp: `Dockerfile` takes `APP_VERSION`/`APP_REVISION` (+ OCI labels)
  and `GET /health` now returns the running `version` + commit `revision`.
- `apps/mobile/eas.json` (EAS Build profiles) + `runtimeVersion` policy for the Expo app.
- Browser e2e suite (Playwright) in `tests/e2e-ui/` — `pnpm test:e2e:ui`. Deterministic
  Chromium specs for login, chat (LLM stubbed), project create, and user create/delete.
- `data-testid` anchors on the login / chat / projects / users surfaces and `role="dialog"`
  on `<Dialog>` / `<ConfirmDialog>` for stable test/automation locators.
- Open-source project files: `CODE_OF_CONDUCT.md`, issue & pull-request templates, this
  changelog.

### Fixed

- `DELETE /api/admin/users/:id` returned 500 on a successful delete. `users.delete` checked
  `result.rowCount`, which the postgres-js driver does not populate; switched to the
  codebase-standard `.returning()` + length check.

## [0.1.0]

- Initial release.
