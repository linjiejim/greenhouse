# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.2.0](https://github.com/linjiejim/greenhouse/compare/v2.1.0...v2.2.0) (2026-10-17)


### Added

* **desktop:** choose the server in the v2 web app ([18bd15a](https://github.com/linjiejim/greenhouse/commit/18bd15a33f89e2b9568645b0eb276292faca9f99))


### Fixed

* **desktop:** read the crate directory when build.rs runs ([44f0df2](https://github.com/linjiejim/greenhouse/commit/44f0df2b554215c0269d836cca2291704db244d1))
* **web:** keep keyboard focus in the directory while pages load and lists refresh ([#79](https://github.com/linjiejim/greenhouse/issues/79)) ([8856d9b](https://github.com/linjiejim/greenhouse/commit/8856d9bdcdcb4ea54700950df084f2db5471a0ec))
* **web:** keep realtime message changes that land while a page is loading ([#81](https://github.com/linjiejim/greenhouse/issues/81)) ([78ab528](https://github.com/linjiejim/greenhouse/commit/78ab52806f9d5905fc04dfe02aeabfc1219671d2))

## [2.1.0](https://github.com/linjiejim/greenhouse/compare/v2.0.0...v2.1.0) (2026-10-16)


### Added

* **design:** keep the watch glanceable and the lock screen private ([5cfa3eb](https://github.com/linjiejim/greenhouse/commit/5cfa3ebd88228886091584d4fe8bb06dbdc1339b))
* **design:** show every device in the prototype ([9a0023e](https://github.com/linjiejim/greenhouse/commit/9a0023e908456ea40fa71400ad074411338e1910))
* **desktop:** let installed desktop apps run the v2 web bundle ([1b2047c](https://github.com/linjiejim/greenhouse/commit/1b2047cb3bb73128fd73e4799b83b694b25e5fbd))
* **ui:** add an isolated V1/V2 plant motion review ([#74](https://github.com/linjiejim/greenhouse/issues/74)) ([a01d739](https://github.com/linjiejim/greenhouse/commit/a01d739d4400860e09f0a9a09da6979231ce9cda))
* **ui:** adopt V2 plant motion on web and native ([#78](https://github.com/linjiejim/greenhouse/issues/78)) ([2da2711](https://github.com/linjiejim/greenhouse/commit/2da27110ab664927d07392ab05fd9086da361e2a))

## [2.0.0](https://github.com/linjiejim/greenhouse/compare/v1.3.2...v2.0.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* v2 uses a new database and cannot upgrade a v1 deployment in place. See docs/product/migration-v1.md.
* v2 uses a new database and cannot upgrade a v1 deployment in place. See docs/product/migration-v1.md.
* **mobile:** none of these screens or modules exist any more; the app only works against a v2 server.
* **mobile:** the app only signs in to v2 servers; a v1 station is named as one that needs updating.
* **v2:** v1 is only on main; nothing on this branch is compatible with a v1 deployment.

### Added

* **agent-core:** move to AI SDK 7 ([f8e5778](https://github.com/linjiejim/greenhouse/commit/f8e5778a7d762df30f46b145646f973e236f802e))
* **agent-core:** one loop assembly for chat and every headless run ([bc7f935](https://github.com/linjiejim/greenhouse/commit/bc7f93510f0e4ba655829e0d9c903a6e65aa8f4e))
* **agent-core:** report headless step progress ([4251c1b](https://github.com/linjiejim/greenhouse/commit/4251c1b124ade39f40c67a59028a36551ea7f981))
* **agents:** enforce published Agent monthly budgets ([2ecedc2](https://github.com/linjiejim/greenhouse/commit/2ecedc2662223fe95931eca43c62992e54e7cae3))
* **agents:** pick the model an Agent answers with ([1b8fb71](https://github.com/linjiejim/greenhouse/commit/1b8fb71513c69426335e16c153f217e05b3a2f58))
* **always-on:** add approvals, event wakes and background writes ([b73824c](https://github.com/linjiejim/greenhouse/commit/b73824cde0e94e03888f6710882762ccf4f6ac30))
* **api,web:** prompt caching with neutral breakpoints and a stable prefix ([3d8f32a](https://github.com/linjiejim/greenhouse/commit/3d8f32aa848931af6b18f95b3bfaf43e417323fd))
* **api,web:** realtime hot path: one audience lookup per turn, framed deltas, resync ([a0a3061](https://github.com/linjiejim/greenhouse/commit/a0a306115c14f339b8171c8f1f8a88c6ead9ce10))
* **api:** add split workers, drain and turn recovery ([9d37005](https://github.com/linjiejim/greenhouse/commit/9d37005773e94141f724629f19496a256e1b11f7))
* **api:** an account's language follows the app until the member picks one ([ab75d3c](https://github.com/linjiejim/greenhouse/commit/ab75d3cd52fd0e19ad6cd33962df9801f84ae71b))
* **api:** audit admin changes and scope getDb() to the open transaction ([bcc912a](https://github.com/linjiejim/greenhouse/commit/bcc912a9c6fcbc9ee82c4487afbc55753d84d831))
* **api:** budgets, public Agents, signed file links and computer access ([f3701be](https://github.com/linjiejim/greenhouse/commit/f3701be609e34e1432873ff207cf50e69bd821b5))
* **api:** carry out every card decision through a durable job, exactly once ([65370a6](https://github.com/linjiejim/greenhouse/commit/65370a6be41438d51c732a984ccfdeeb68dd3221))
* **api:** deliver notifications by email, Feishu, WeCom and push ([e98b0ab](https://github.com/linjiejim/greenhouse/commit/e98b0ab045c79f3d68165940ba92fbee5d54e40a))
* **api:** E2B sandboxes from env, the computer template and a live test ([deaadd3](https://github.com/linjiejim/greenhouse/commit/deaadd3d1a18342dfa271d98ea3a852c704f1897))
* **api:** knowledge.changed tells screens the knowledge tree changed ([7b212b8](https://github.com/linjiejim/greenhouse/commit/7b212b88c0141a25163fb08b784cfd6ef4cf8ae8))
* **api:** list sessions with one Bot (`GET /api/sessions?profile=`) ([e24db1b](https://github.com/linjiejim/greenhouse/commit/e24db1b159ae424e85f87698903fb3071aed4d1b))
* **api:** never replay a call with effects that a crash left unfinished ([7e50a79](https://github.com/linjiejim/greenhouse/commit/7e50a793acd0921d7d86f8e8730487eba65a5aa7))
* **api:** OAuth 2.1 server, personal access tokens and the MCP server ([5bd9ab5](https://github.com/linjiejim/greenhouse/commit/5bd9ab54740e7233ab723882cf8b965f1de186ba))
* **api:** queue a schedule's run in the transaction that claims the firing ([f19e310](https://github.com/linjiejim/greenhouse/commit/f19e310c1385c0d3421c35e6a99c8b833e6be786))
* **api:** record each model step and resume background runs from them ([805c45b](https://github.com/linjiejim/greenhouse/commit/805c45b95468dd8fb4a15a07cbc3e4f140b7a79f))
* **api:** reply and mention notifications ([ca00901](https://github.com/linjiejim/greenhouse/commit/ca009016cafe1337e832cde41371e25851e8e4ec))
* **api:** skill library, scan review, `/` runs and official skills ([91858bc](https://github.com/linjiejim/greenhouse/commit/91858bc91d772ce6e7189a59f87e4457a1748e3c))
* **api:** the Agent's browser and a password vault it signs in with ([4e6be7b](https://github.com/linjiejim/greenhouse/commit/4e6be7b49c324d49b269b72386c526a084346ade))
* **api:** the knowledge base, its contract and the Agent tools ([383996f](https://github.com/linjiejim/greenhouse/commit/383996fe66f35f893db97cd089c13096aa870b3f))
* **api:** v2 API skeleton with sign-in, members and the error envelope ([253d197](https://github.com/linjiejim/greenhouse/commit/253d19733357f8376a23fc23c80ac5ccbdc00cc6))
* **api:** voice — transcription and speech through STT and TTS, audio attachments transcribed ([eb43afd](https://github.com/linjiejim/greenhouse/commit/eb43afd4338f2f88ab42d3f11a1203d42083c3c1))
* **apps:** add builder, runtime and reviewed templates ([5cd53ac](https://github.com/linjiejim/greenhouse/commit/5cd53ac0fad79986aa20ac53aa869e162eeb283e))
* **avatars:** a Bot's colour, and faces that follow state ([da73197](https://github.com/linjiejim/greenhouse/commit/da73197df8489d9e79451a3821113886902dec9c))
* **bots:** Bot computers can run as hosted E2B sandboxes ([#52](https://github.com/linjiejim/greenhouse/issues/52)) ([3e7dd6c](https://github.com/linjiejim/greenhouse/commit/3e7dd6ca6ac7fb15c1da7fdc4a0e6feb56ccd395))
* **bots:** computers on from Runtime Config, vault key rotation, live CI ([#57](https://github.com/linjiejim/greenhouse/issues/57)) ([bab1140](https://github.com/linjiejim/greenhouse/commit/bab1140a9e61d8d73603eb050dbbadc71c2e89b2))
* **bots:** converge agent profiles into private Bot identities ([#40](https://github.com/linjiejim/greenhouse/issues/40)) ([09d4a00](https://github.com/linjiejim/greenhouse/commit/09d4a0057e2d1134028b37f2ec618303032832a1))
* **bots:** count unread Bot replies per conversation ([3b372b8](https://github.com/linjiejim/greenhouse/commit/3b372b86e1cf03678608f5436d13cfb35804389b))
* **bots:** enable Agent conversations and read receipts ([#67](https://github.com/linjiejim/greenhouse/issues/67)) ([a6f9b94](https://github.com/linjiejim/greenhouse/commit/a6f9b941262684be7ae21fbd44ce4506b124d741))
* **bots:** encrypted home backups — restore lost computers, move between providers ([#59](https://github.com/linjiejim/greenhouse/issues/59)) ([8fdaab1](https://github.com/linjiejim/greenhouse/commit/8fdaab16d7bcf1be49b0e115530a9276471e9f53))
* **bots:** keep hosted computers' member accounts off metadata and internal networks ([#61](https://github.com/linjiejim/greenhouse/issues/61)) ([1f095a7](https://github.com/linjiejim/greenhouse/commit/1f095a7cfb71a440185033e2436d7ea0f2ad4098))
* **bots:** make Agents first-class teammates ([#65](https://github.com/linjiejim/greenhouse/issues/65)) ([d12e370](https://github.com/linjiejim/greenhouse/commit/d12e3707398cd3735e62ec932dc6c1f570b57d6b))
* **bots:** personal assistants with computers, vault and conversations ([#38](https://github.com/linjiejim/greenhouse/issues/38)) ([1cf1f5b](https://github.com/linjiejim/greenhouse/commit/1cf1f5b29bcb709954e5f49a8b6ceffadaa14d6f))
* **bots:** previews, process wake-ups and readable long pages for Bot computers ([#55](https://github.com/linjiejim/greenhouse/issues/55)) ([f73cce8](https://github.com/linjiejim/greenhouse/commit/f73cce864f473aab035ad4d8bbcb8c464895b260))
* **bots:** retire group chats — Bots bring each other into a DM ([61d8ecc](https://github.com/linjiejim/greenhouse/commit/61d8ecc76342c0d8edbf5caa52f35bbde9383fdb))
* **bots:** short greetings, concise-but-proactive replies, readable approval cards ([e6727c9](https://github.com/linjiejim/greenhouse/commit/e6727c9bb718f19217e6ecb03136669b46e89a3c))
* **bots:** three example Bots that need no computer ([212ecbb](https://github.com/linjiejim/greenhouse/commit/212ecbbb1d6b19a94058e207a595d16f761eb13e))
* **brand:** adopt Haven identity and Nunito across clients ([#42](https://github.com/linjiejim/greenhouse/issues/42)) ([333d193](https://github.com/linjiejim/greenhouse/commit/333d193790e48111c9a569d2e9c0b990ab4b8b69))
* **chat:** mask earlier tool results in a long turn ([efa916b](https://github.com/linjiejim/greenhouse/commit/efa916b08e8db84e30920c2cc887cbeb9d903586))
* **computers,apps:** add backups, queues and reviewed cards ([162d34f](https://github.com/linjiejim/greenhouse/commit/162d34f18065eb281bd3498de10d3b81d2316b6a))
* **computers:** admins set the capacity and can stop or reset any computer ([f56acae](https://github.com/linjiejim/greenhouse/commit/f56acae55ed51394abda37176a3c549756102374))
* **computers:** an Agent computer on the sandbox provider, and the long-run probe ([8b3a060](https://github.com/linjiejim/greenhouse/commit/8b3a060d4511fc4581df376e5ce6933ea3939a33))
* **connectors:** admins install MCP servers, members connect, Agents call them ([43fed9c](https://github.com/linjiejim/greenhouse/commit/43fed9c30d9c84f964a770496395150961bfac97))
* **connectors:** the personal mailbox as a built-in connector ([e7a76aa](https://github.com/linjiejim/greenhouse/commit/e7a76aa1f448748f820fcb097a7fe3e31596720a))
* **contract:** external access shapes and client calls ([e24224f](https://github.com/linjiejim/greenhouse/commit/e24224f211eb80e609891997e74e4fd8133df0bc))
* **contract:** notification settings, push devices and channel shapes ([75710da](https://github.com/linjiejim/greenhouse/commit/75710da4f00067e5a3d6c7bc26f4e170989f2e52))
* **contract:** skill shapes, the message's skill and skills.* client calls ([17a4b2a](https://github.com/linjiejim/greenhouse/commit/17a4b2a3ef4cfe2f7bf59bab9f6f95f82e32336c))
* **contract:** the typed API client, with token refresh across tabs and the realtime socket ([d6c9250](https://github.com/linjiejim/greenhouse/commit/d6c9250088a3526e8f2d86d4d53989eae6980dc7))
* **conversations:** a reply shows where its facts came from ([efffc39](https://github.com/linjiejim/greenhouse/commit/efffc392677e387a78ded4b65fbe3652ad43eef2))
* **conversations:** edit and regenerate, feedback, room members, shared notes, export and search ([c662d05](https://github.com/linjiejim/greenhouse/commit/c662d05e647f234a2965def3aa8f73962d8f413f))
* **conversations:** read receipts in rooms, and starters for a new chat ([74e3280](https://github.com/linjiejim/greenhouse/commit/74e3280aac8bfe4c823c033cfd07835396590bc2))
* **conversations:** replies use every rich block the sending screen draws ([36a207c](https://github.com/linjiejim/greenhouse/commit/36a207c77c08b07f2a12cdd9473c55b9b2787288))
* **db:** connectors and members' connections ([3b0a063](https://github.com/linjiejim/greenhouse/commit/3b0a063374986c414f40272beea33f4677394fe4))
* **db:** knowledge tables and Chinese and English full-text search ([d2dacac](https://github.com/linjiejim/greenhouse/commit/d2dacacaef1cbbcb4bb4c9ef24d8e2115ebe08d5))
* **db:** push devices, and notification settings by category ([4ad3cd8](https://github.com/linjiejim/greenhouse/commit/4ad3cd83d664bfb642042c12d73f6d71784bf52f))
* **db:** skills and skill versions tables ([0f45973](https://github.com/linjiejim/greenhouse/commit/0f45973b5ea1ac38147f99c5839fecce20572ddc))
* **db:** tables for OAuth clients, grants, codes and tokens ([c88e4ea](https://github.com/linjiejim/greenhouse/commit/c88e4ea4530bc555882096ac824b107aa1616370))
* **db:** v2 schema baseline for identity, agents, conversations and runs ([9fabc0b](https://github.com/linjiejim/greenhouse/commit/9fabc0be6abfc6e2777d9bc4cf3dfab751dbb268))
* **deploy:** one-click install, Railway, and a first admin without exec ([#49](https://github.com/linjiejim/greenhouse/issues/49)) ([2bc5993](https://github.com/linjiejim/greenhouse/commit/2bc5993ae6db74db1cf352c077730809f1253658))
* **design:** add the Native Haven v2 design system and prototype ([29baa21](https://github.com/linjiejim/greenhouse/commit/29baa219b0947ac2902813e421f2f88267197182))
* **engine:** a rolling summary for long conversations ([cb76c42](https://github.com/linjiejim/greenhouse/commit/cb76c420f782caa1620a0ab2e68560fcf00ac483))
* **engine:** add concise replies and private workflow tools ([9b54831](https://github.com/linjiejim/greenhouse/commit/9b548316d61b735ce644ee33b2ae26b58fd58069))
* **engine:** add M2.4 grants, helper runs and eval replay ([946e7aa](https://github.com/linjiejim/greenhouse/commit/946e7aac523b97c482c4c5234a93dc2e822d7c12))
* **engine:** agents, conversations and the single-writer conversation engine ([7fd9259](https://github.com/linjiejim/greenhouse/commit/7fd925916ea0a7a9d45f5051a4fc8e214d7c90ef))
* **engine:** background runs, the Runs API and the web tools ([73d5f90](https://github.com/linjiejim/greenhouse/commit/73d5f9096c8dcb6e3c2deeb3db32fed47bf9b1f2))
* **engine:** hand-offs between a member's Agents ([bc21bd5](https://github.com/linjiejim/greenhouse/commit/bc21bd51ebc52923d71b43f7e9fc043feae4ee91))
* **engine:** needs you: approvals, questions, proposals and notifications ([8e9f628](https://github.com/linjiejim/greenhouse/commit/8e9f6288c9deb78e6d041aaaa65bdfebac68bc53))
* **engine:** schedules that belong to an Agent ([373b30b](https://github.com/linjiejim/greenhouse/commit/373b30be5dbf135b1d8658d43d3097f154130249))
* **eval:** an agent scenario bank, and ground truth that never breaks a run ([d0f7ca9](https://github.com/linjiejim/greenhouse/commit/d0f7ca928c8f44af0852f789ee4058de303bb0ec))
* **feishu:** a live "processing" card and dedup across re-sent message ids ([e4cb92e](https://github.com/linjiejim/greenhouse/commit/e4cb92ec8b66da7d8ceb4ccdfa149baf9557bffb))
* **files:** one file service, attachments and images for vision models ([aaa1427](https://github.com/linjiejim/greenhouse/commit/aaa14277bb73cf222ba8a7f24bd51bfb722acdc1))
* Greenhouse v2 ([#69](https://github.com/linjiejim/greenhouse/issues/69), [#70](https://github.com/linjiejim/greenhouse/issues/70)) ([5b08bbf](https://github.com/linjiejim/greenhouse/commit/5b08bbfc97d00273300948dff816dfca48fc5cb6))
* Greenhouse v2 ([#70](https://github.com/linjiejim/greenhouse/issues/70)) ([917429b](https://github.com/linjiejim/greenhouse/commit/917429b29c3017134ac311587dcc2b47a1d69b38))
* **knowledge-editor:** mentions keep their member link through the editor ([a6ff601](https://github.com/linjiejim/greenhouse/commit/a6ff60136a057fd4952dac177db4cb98c1b9c342))
* **knowledge-editor:** the browser editor with / blocks, [[ doc links, @ mentions and pictures ([0afdcdf](https://github.com/linjiejim/greenhouse/commit/0afdcdf0d97f7e233815c2d46bec22c6f35084e2))
* **m3:** add page assistant, media, interjections and metrics ([37beb48](https://github.com/linjiejim/greenhouse/commit/37beb48cc7e63fe70df1d624425706d1650db1e8))
* **mail:** mail service capability, system mail and Agent mailboxes ([59b36c7](https://github.com/linjiejim/greenhouse/commit/59b36c7db079d4b209172c391d75aa55cb6aeec4))
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
* **mobile:** add native knowledge, tables, voice and mail ([524a2f1](https://github.com/linjiejim/greenhouse/commit/524a2f13c90bdecd27f1903d66faf856b3cd617c))
* **mobile:** Agents, runs, the computer and settings on v2 ([533e97d](https://github.com/linjiejim/greenhouse/commit/533e97d6ef0179eade0f424c108f674abe054328))
* **mobile:** avatars that blink, glance and talk, with a face for every state ([908e934](https://github.com/linjiejim/greenhouse/commit/908e934dc0365c3cd840f692e43aa740cdb538cc))
* **mobile:** Bots foundation — contracts, vendored web logic, API client, store, routes ([6a25b81](https://github.com/linjiejim/greenhouse/commit/6a25b81490da78162b79dc39ba79256591717504))
* **mobile:** Bots in the drawer and home ([25cbb89](https://github.com/linjiejim/greenhouse/commit/25cbb89b8952dfa886fab1adb25a2b3f57874683))
* **mobile:** Bots request cards and needs-you ([5276804](https://github.com/linjiejim/greenhouse/commit/5276804eae720aca5721682619d8d8103d4c99ff))
* **mobile:** Bots thread engine and realtime ([0d9038d](https://github.com/linjiejim/greenhouse/commit/0d9038d339ebe189eb656acf7c6e8c0b9a71cd7a))
* **mobile:** Bots thread screen ([e42c6d7](https://github.com/linjiejim/greenhouse/commit/e42c6d7ae23545ecec72615df7a18b320e8cda79))
* **mobile:** calmer chat and Bots threads ([5b7026e](https://github.com/linjiejim/greenhouse/commit/5b7026e32999c692bae7183b4f55d169924cfb7f))
* **mobile:** charts by Swift Charts; the HTML card opens its page ([c0696cb](https://github.com/linjiejim/greenhouse/commit/c0696cb28988955537c9148651cdf7a2cc15100a))
* **mobile:** close daily-use parity gaps and polish native screens ([b5c4144](https://github.com/linjiejim/greenhouse/commit/b5c4144ab5b8223a4defa9564ea063d73421351a))
* **mobile:** connectors — connect your own account from Settings or the chat ([c24fec8](https://github.com/linjiejim/greenhouse/commit/c24fec8a95626b31fa1af56e0cf499204bf68806))
* **mobile:** drawer — Knowledge and Projects at the bottom, hairlines between Bots ([7304418](https://github.com/linjiejim/greenhouse/commit/730441896f54ab786c4df5bbb3a71784c0ae3549))
* **mobile:** integrate v2 apps and always-on flows ([b03be67](https://github.com/linjiejim/greenhouse/commit/b03be67eeb6c7ff4873baa521b29d41142351188))
* **mobile:** keep the account language in step with the app's ([d86a31e](https://github.com/linjiejim/greenhouse/commit/d86a31e3b36b71e4e1e24532b86bdee6863a8a15))
* **mobile:** manage Bots and groups on mobile ([d5b02e8](https://github.com/linjiejim/greenhouse/commit/d5b02e8c7990f4a643117d355e9e62825e085f62))
* **mobile:** native iOS rewrite on Expo SDK 57 ([#37](https://github.com/linjiejim/greenhouse/issues/37)) ([8d8d9d1](https://github.com/linjiejim/greenhouse/commit/8d8d9d1641945699b1ed0fc1b93fbf9a4f76cac0))
* **mobile:** needs-you cards, the notification center and pushes on v2 ([f307a4e](https://github.com/linjiejim/greenhouse/commit/f307a4e51994dd458ba9a82cda4e92d3e5b9516b))
* **mobile:** new chats start with Sprouty; a splash that plays in full ([01537e1](https://github.com/linjiejim/greenhouse/commit/01537e103fa101f88098b8ad574439fc17c27b4a))
* **mobile:** no agent picker above the new chat's composer ([49f23c6](https://github.com/linjiejim/greenhouse/commit/49f23c6912593b6f817603f06bc1900c3e372725))
* **mobile:** pick a Bot's connectors on the phone ([0333838](https://github.com/linjiejim/greenhouse/commit/03338384b3abf74ca21d358e236e649de7399112))
* **mobile:** retire group chats on the phone ([88fd466](https://github.com/linjiejim/greenhouse/commit/88fd466841f1f53fdf33181af9a9db97531d094b))
* **mobile:** sign in, refresh and check the version against API v2 ([131166b](https://github.com/linjiejim/greenhouse/commit/131166b285f2bc52a0eb321344e48d54b54c8c31))
* **mobile:** the account takes the app's language until the member picks one ([4e8835a](https://github.com/linjiejim/greenhouse/commit/4e8835ade0d28c7c8fc9eb1937c9b87414c741fc))
* **mobile:** the drawer shows today and pinned, folds the rest, keeps apps in a bar ([5066a1c](https://github.com/linjiejim/greenhouse/commit/5066a1cdfc3c99951a95f7ea1cf35f37642376bc))
* **mobile:** the home-screen widget lines up your Bots ([8c1176f](https://github.com/linjiejim/greenhouse/commit/8c1176fad10faaacc42b5d4d32f05deabafb6dd8))
* **mobile:** the realtime socket and the data layer on API v2 ([855fcdd](https://github.com/linjiejim/greenhouse/commit/855fcdd498a641dbb46fdd7c39195ec01042089e))
* **mobile:** the shell and conversations on API v2 ([5f0a063](https://github.com/linjiejim/greenhouse/commit/5f0a06372d9eaf2fb523c24c4e3401ca9abfdec0))
* **mobile:** the widget and Live Activities follow v2 Agents and runs ([671a5d1](https://github.com/linjiejim/greenhouse/commit/671a5d1a94ebe72d4baf82b33187fdb996daf44a))
* **platform:** add v2 extensions and operational controls ([e227ce3](https://github.com/linjiejim/greenhouse/commit/e227ce31b7095b49313448176cb308638e869fc8))
* **providers:** a DevTools byte stream into the computer's browser ([ad4983d](https://github.com/linjiejim/greenhouse/commit/ad4983da1f6ee47c6f0f79053e45cc8801c97eea))
* **providers:** E2B sandbox adapter for E2B and compatible hosts ([f5a7c90](https://github.com/linjiejim/greenhouse/commit/f5a7c906daaf252b3c1202864e402800e9e27902))
* **providers:** Feishu, WeCom and Expo push as channel adapters ([0b69997](https://github.com/linjiejim/greenhouse/commit/0b6999742ab3b88a89520eec468fa7caf522947a))
* **providers:** one provider layer for models, storage and every external service ([019b9f7](https://github.com/linjiejim/greenhouse/commit/019b9f72899392ac8d80fbe4a5f0fd074c687d15))
* **providers:** search, speech and image adapters ([d8bcc03](https://github.com/linjiejim/greenhouse/commit/d8bcc0347aa43d38717beb0173fba2f382458809))
* **realtime:** the one WebSocket, /api/ws ([fe450b2](https://github.com/linjiejim/greenhouse/commit/fe450b2b9f42795ddf513826d79b9d8837012b80))
* **requests:** retire replaced approvals and clear notifications ([9e7167f](https://github.com/linjiejim/greenhouse/commit/9e7167fc5bc5c2a1032e210d466cdb05ea01123c))
* **rich-output:** stats/cards/steps blocks, reply buttons, per-screen capabilities ([#43](https://github.com/linjiejim/greenhouse/issues/43)) ([928c72d](https://github.com/linjiejim/greenhouse/commit/928c72df394d7d17e65730c7034a117d72d5f91c))
* **site:** launch bilingual Greenhouse v2.0.0 website ([76f8584](https://github.com/linjiejim/greenhouse/commit/76f858492b1dd6dcfeaf7d6218c810b2b1a2da98))
* **tables:** add Agent tools, handoffs and automations ([69959d8](https://github.com/linjiejim/greenhouse/commit/69959d86c68028f21e5d5a6bd0650e0fc42cb74a))
* **tables:** bases, fields, views and records for 表格 (M2.2 phase 1) ([2b55294](https://github.com/linjiejim/greenhouse/commit/2b55294a81e36b6e53f55e7e2877f873c72a3656))
* **tables:** groundwork for phase 2 (computed fields, forms, imports, dashboards, roles) ([138492b](https://github.com/linjiejim/greenhouse/commit/138492bd8200927db9580fe15be2c825f4df73be))
* **tables:** phase 2 — forms, CSV import, dashboards, computed fields, custom roles ([4cf840c](https://github.com/linjiejim/greenhouse/commit/4cf840c886ee5423562d1d064df3a5637a908432))
* **ui:** a MultiSelect says when its list closes ([788d107](https://github.com/linjiejim/greenhouse/commit/788d1072027c936bfe403f2cf48ad4ccecabd8bb))
* **ui:** FieldGroup for controls made of several elements ([2c47b0b](https://github.com/linjiejim/greenhouse/commit/2c47b0b9ce33c5b7d89b8595efaca48f74cf341b))
* **ui:** popover panels, pickers that open where a value is edited ([5f5a5ea](https://github.com/linjiejim/greenhouse/commit/5f5a5ea112a92ba785a36553b9921e56f75a385c))
* **ui:** the component kit in packages/ui, used by the prototype (M0.2) ([56d336f](https://github.com/linjiejim/greenhouse/commit/56d336f91a2298f550e090855582e2ed448ee8de))
* **web:tables:** finish computed fields and custom roles ([bcd26c6](https://github.com/linjiejim/greenhouse/commit/bcd26c6b0decc8b064e121b6ffd85abd61b684d6))
* **web:** a chat's own model, and the whole computer in a conversation ([5564db3](https://github.com/linjiejim/greenhouse/commit/5564db3e68516e5377594eee631bf4755a7f1d8e))
* **web:** a first deploy starts at 管理 → 服务 ([f41b632](https://github.com/linjiejim/greenhouse/commit/f41b6321c8d3d560772054217294138ff7ca2c42))
* **web:** Agent mailboxes, mail cards and the mail service in the web app ([31986ac](https://github.com/linjiejim/greenhouse/commit/31986ac77d33f3fadaa6a537671215f631ab09c2))
* **web:** an Agent's plant moves while it answers and waits when it needs you ([e90c555](https://github.com/linjiejim/greenhouse/commit/e90c555877b0b1f934fb5629b95ffd72fe2a4f1d))
* **web:** attachments, avatars and logo, usage and budgets, publishing ([b3cf554](https://github.com/linjiejim/greenhouse/commit/b3cf554c198a32c1dade38aedbfe31f2cf4e41b7))
* **web:** connectors — install from the catalog, connect your own account ([1550fd4](https://github.com/linjiejim/greenhouse/commit/1550fd4b6eb7c0ac78055b8944920545e39c3760))
* **web:** connectors, external access and the OAuth consent page ([c0bc018](https://github.com/linjiejim/greenhouse/commit/c0bc01828a7725b63c847f276a5c98d715b75e92))
* **web:** notification settings, my phones and the channels admins set up ([91e91a6](https://github.com/linjiejim/greenhouse/commit/91e91a6cbe2e817475de2d3871adc1440c66101e))
* **web:** pick a Bot's colour instead of a mood ([3939d58](https://github.com/linjiejim/greenhouse/commit/3939d5850261e9694c58f263d9729d78fe724c3d))
* **web:** ratings, edit and regenerate, rooms, shared notes, export and ⌘K search ([d6a9e08](https://github.com/linjiejim/greenhouse/commit/d6a9e08fd109a86324ef9ef183927eb3b9fb1112))
* **web:** retire group chats in the Bots UI ([b0893d2](https://github.com/linjiejim/greenhouse/commit/b0893d22ecf1a9b3101ede5cf1f5ffc9599413dc))
* **web:** rich blocks in replies, and the Agent's computer screen and terminal ([633c153](https://github.com/linjiejim/greenhouse/commit/633c153a3d20fa148be3074a378564819881dfb6))
* **web:** runs, settings and admin on the existing API (M1.4, M1.5) ([4e2ba7f](https://github.com/linjiejim/greenhouse/commit/4e2ba7fcb3a6fac6dc933adc609a94b3ea872fd7))
* **web:** say when the live connection drops, and title each page ([9ff798b](https://github.com/linjiejim/greenhouse/commit/9ff798b0599fa26d8663a5ba70a1e1aa0d5b847b))
* **web:** skills: the library, running one with /, starters and equipping ([8358c3a](https://github.com/linjiejim/greenhouse/commit/8358c3a4cd15552aff99c99c01f99db0ae266255))
* **web:** the composer's microphone and read-aloud through the speech services ([3fcbd94](https://github.com/linjiejim/greenhouse/commit/3fcbd948d1a1db3c1b0f8a65abccefdbfb190b8d))
* **web:** the computer's files, take-over cards and live computer state ([3fc5a2a](https://github.com/linjiejim/greenhouse/commit/3fc5a2a6ae61421d0760c8586e7a9cbd1569757e))
* **web:** the knowledge base: tree, folders, docs, the editor, versions, sharing and files ([2785b5f](https://github.com/linjiejim/greenhouse/commit/2785b5f83daacbc0ed0ad17298af3880f62b100e))
* **web:** the new web app's foundations, served by the API ([53d8a3d](https://github.com/linjiejim/greenhouse/commit/53d8a3db0efcac6ab143d12baa401cd2e45c5c21))
* **web:** the password vault, and sign-in cards that can be allowed ([8a26a59](https://github.com/linjiejim/greenhouse/commit/8a26a596d3c1828055be66da27771e63dc0d8ff2))
* **web:** the shell, conversations and Agents on the kit (M1.1–M1.3) ([faeab4b](https://github.com/linjiejim/greenhouse/commit/faeab4b834064c95ee9af73d45d398f9fd050c60))
* **web:** 表格 on the web (M2.2 phase 1) ([28d6083](https://github.com/linjiejim/greenhouse/commit/28d608355fb9dac6855852a85c0bc7d20b7945d0))
* your computer on the phone — watch, take over, files; Bots stop sending unasked screenshots ([#62](https://github.com/linjiejim/greenhouse/issues/62)) ([42029e5](https://github.com/linjiejim/greenhouse/commit/42029e50f72b42d7f00c18c5d312ee29336dd400))


### Fixed

* **acceptance:** align native previews and close engine timers ([139a848](https://github.com/linjiejim/greenhouse/commit/139a848c3c9291c36ad4928f50c3dfd20d5e345c))
* **acceptance:** make approvals and write evidence human readable ([d9f4875](https://github.com/linjiejim/greenhouse/commit/d9f48751bd14c194c14d4a2e2ef98413dcc3fafd))
* **acceptance:** render native findings and explain memory refusals ([e9d1bbe](https://github.com/linjiejim/greenhouse/commit/e9d1bbebbb7ed7209886b79d8327190ad0b3e1f0))
* **acceptance:** resolve follow-up real-model findings ([d802925](https://github.com/linjiejim/greenhouse/commit/d8029256ef2503bf8a37fa3ae5f025184d55ae04))
* **agent-core:** catch the `<｜｜DSML｜｜ calls>` leak variant ([78c45ce](https://github.com/linjiejim/greenhouse/commit/78c45ce22ed72d5af225050d762cb16cb31537e8))
* **agent-core:** don't send a temperature DeepSeek ignores while thinking ([e5d14f5](https://github.com/linjiejim/greenhouse/commit/e5d14f5270ca5ad8429dd9e3bdaf0edcee6c1e8e))
* **agent-core:** headless runs pass only the timeouts generateText honours ([f539bbc](https://github.com/linjiejim/greenhouse/commit/f539bbc149958f5e381f425b69cebeb43aac5c0f))
* **api,web:** recover the NOTIFY connection, and drop messages deleted while away ([44ab91a](https://github.com/linjiejim/greenhouse/commit/44ab91a961f0af5f3a8edb028c128aae4f2b0ff4))
* **api:** a decision woken while a pass ends is never left for the next poll ([0c59efa](https://github.com/linjiejim/greenhouse/commit/0c59efa84de284a8fb41191f76abb37cc14a4642))
* **api:** a refused connector key keeps its reason apart; the model points at the card ([c3caeb6](https://github.com/linjiejim/greenhouse/commit/c3caeb695f4ad0703acb6121dba77593661f987e))
* **api:** a turn's events keep each reader's doc sources; bulk record changes cross processes ([8d091d5](https://github.com/linjiejim/greenhouse/commit/8d091d554a2d46f358451a21288dd1b17c004977))
* **api:** bound the text read from uploads ([f98ec74](https://github.com/linjiejim/greenhouse/commit/f98ec748b2661dcf18722ea0820aa904d15b2393))
* **api:** cap computer file uploads that do not say how long they are ([0eb5921](https://github.com/linjiejim/greenhouse/commit/0eb5921f19fa39096f7672340ef020a481df86ab))
* **api:** cap upload bodies that do not say how long they are ([6a7bcdd](https://github.com/linjiejim/greenhouse/commit/6a7bcddd4034ea1794781cd798113cfd6afa031c))
* **api:** decisions each on their own, turns always start, safer resume numbering ([856daae](https://github.com/linjiejim/greenhouse/commit/856daaea8f007fc0e836720ec68e3070f7f5cf73))
* **api:** doc and folder notifications link to the knowledge base and name who did it ([4d79139](https://github.com/linjiejim/greenhouse/commit/4d79139e7fe24e9f9d5415b0e5a1ea335d4f5187))
* **api:** enforce the doc length limit in the knowledge service ([a5c736d](https://github.com/linjiejim/greenhouse/commit/a5c736d1afccacf79a919f794ed331cb8b8c266a))
* **api:** export knowledge without holding every doc in memory ([febf58f](https://github.com/linjiejim/greenhouse/commit/febf58f07b261f005cb394afbec85ee4d307f889))
* **api:** keep a room's other members from seeing docs only the asker may read ([15e5303](https://github.com/linjiejim/greenhouse/commit/15e530339ced2f060f536aa9bd5f51298e212793))
* **api:** keep doc diffs and edit-card previews cheap ([7bf00ef](https://github.com/linjiejim/greenhouse/commit/7bf00effa3e668a9353c341d7f867a7b2f0bda05))
* **api:** keep knowledge Markdown parsing linear on hostile input ([600ff37](https://github.com/linjiejim/greenhouse/commit/600ff37c28c17ff26ccef355753a01e7cc85ca7d))
* **api:** keep the API up when a database blip hits a WebSocket connect ([0f88660](https://github.com/linjiejim/greenhouse/commit/0f88660560e052cc520d2b109e5ad4488ad4f92f))
* **api:** limit folder depth and fail on broken trees instead of stopping short ([9bf6bf6](https://github.com/linjiejim/greenhouse/commit/9bf6bf6374b3edfeebd8be99c3939156dffaee2d))
* **api:** order and page knowledge tree lists in the database ([66c8909](https://github.com/linjiejim/greenhouse/commit/66c8909766a79dcc3b929621731802c5703e80f9))
* **api:** presence tells only who has the doc open and drops readers who lost access ([8b4d56e](https://github.com/linjiejim/greenhouse/commit/8b4d56e450d22dc6a942a243813c481902af0a71))
* **api:** saving shares keeps those of members and groups that are gone ([95605ce](https://github.com/linjiejim/greenhouse/commit/95605ce0437cb2a7a0df90a6364302466cbc2ebc))
* **api:** send NOTIFYs on a one-connection client that survives a dropped connection ([2649646](https://github.com/linjiejim/greenhouse/commit/2649646dd4acd95f6be3d3d1c735c94222c5ecc6))
* **api:** settle knowledge places under the tree lock and keep shares out of Agent folders ([93fe506](https://github.com/linjiejim/greenhouse/commit/93fe5067840e485afbea9af46c60120cc28399cb))
* **api:** sign file links only where they are this server's whole link targets ([ea4cead](https://github.com/linjiejim/greenhouse/commit/ea4cead0041e4139c040d60bad2c9c9d5e0f17db))
* **api:** small knowledge correctness fixes ([0e677f3](https://github.com/linjiejim/greenhouse/commit/0e677f3451a39b2f2d41f1215d38e4e725166320))
* **api:** start background workers outside request transactions ([77e11a1](https://github.com/linjiejim/greenhouse/commit/77e11a1418636efecb99fafed0e4a2f8ba97da23))
* **api:** web pages reach the model cut and sanitized like connector output ([04fde28](https://github.com/linjiejim/greenhouse/commit/04fde28c9c4e4a14bb40b9e138e1d856bfacf829))
* **bots:** a card sits under the reply of the turn that raised it ([a0da0ae](https://github.com/linjiejim/greenhouse/commit/a0da0aed0f4d4ee61161c0b9ca76fbcf47581f4d))
* **bots:** an approval card's values read in the member's words ([834d02c](https://github.com/linjiejim/greenhouse/commit/834d02c74a22fee431ecd6810f1ba7fc6c468236))
* **bots:** approval questions no longer repeat the Bot's name ([3a5952b](https://github.com/linjiejim/greenhouse/commit/3a5952bcd5c846915816caa607a06a569a22e712))
* **bots:** hosted computers survive memory hogs and failed home moves ([#54](https://github.com/linjiejim/greenhouse/issues/54)) ([37cd185](https://github.com/linjiejim/greenhouse/commit/37cd18522dadfb3d2b79d654423b947bba546c7c))
* **chat:** on cheap-cache models, mask tool results only when the window needs it ([ce3df49](https://github.com/linjiejim/greenhouse/commit/ce3df49c500db36480d7e153f8e0d71660810e00))
* **computers:** validate live E2B lifecycle and encrypted backups ([06b2edd](https://github.com/linjiejim/greenhouse/commit/06b2eddb74810a6d99cc61b52759be7ff40dbc4a))
* **conversations:** people added together list in a stable order ([f9c3b23](https://github.com/linjiejim/greenhouse/commit/f9c3b238305f94b061bf93b06185172401236049))
* **db:** an Agent's private folder no longer cascades from the Agent ([34d0f28](https://github.com/linjiejim/greenhouse/commit/34d0f2875e4d87a05e2daef5f55005d6c689aec0))
* **db:** ship schema changes as an incremental migration from the deployed baseline ([#75](https://github.com/linjiejim/greenhouse/issues/75)) ([aafd561](https://github.com/linjiejim/greenhouse/commit/aafd5611dacfb9d215fc07ca5a14c4fceaa3ec57))
* **engine:** a card decided before its turn finished no longer leaves the run waiting ([67a54f7](https://github.com/linjiejim/greenhouse/commit/67a54f7323f671ecc68dfc6d354929e9978d44cc))
* **engine:** merge U3 request lifecycle into private tools ([58a58fe](https://github.com/linjiejim/greenhouse/commit/58a58fe2fff9973a039c4289abce647877495b85))
* **engine:** normalize tool schemas for strict providers ([9abdd83](https://github.com/linjiejim/greenhouse/commit/9abdd832aaf70185aeec5f937ce17f25fcbff4ed))
* **engine:** one user message at the end of every prompt, and offsets on streamed text ([2850bc7](https://github.com/linjiejim/greenhouse/commit/2850bc73d699b602fd5160d77f8ea681cce68552))
* **engine:** preserve tool evidence and export member messages ([139a80c](https://github.com/linjiejim/greenhouse/commit/139a80c14c933987b83795273b5c43d6943adbc6))
* **engine:** preserve tool output provenance and paging ([cad7249](https://github.com/linjiejim/greenhouse/commit/cad72499c0012a60974de0db7b42fb3e18be32c7))
* **engine:** title chats from the first member request ([9d944e0](https://github.com/linjiejim/greenhouse/commit/9d944e0a0234adc617590f90b509bb6e8fcb10b2))
* **feishu:** a reply in the chain carries the conversation to the model ([d4fc9bd](https://github.com/linjiejim/greenhouse/commit/d4fc9bdecaf6505592eb87bd946d280868bdb14e))
* **i18n:** share name spacing across web and native ([cc50fb5](https://github.com/linjiejim/greenhouse/commit/cc50fb5556887372267c66ad5af25f802239c037))
* **i18n:** space server copy around names by the shared Han rule ([5255337](https://github.com/linjiejim/greenhouse/commit/52553372706ee6eddcf3d38f548e7e61e71eb427))
* **integration:** merge v2 parity and repair acceptance regressions ([51cbe80](https://github.com/linjiejim/greenhouse/commit/51cbe80b288448030aee61dc9f9defa73d6aaeb1))
* **integration:** retain latest native note navigation fix ([01b6ae0](https://github.com/linjiejim/greenhouse/commit/01b6ae06400fa2b23ed34b67f9bd2f5b0aed9b11))
* **knowledge-editor:** a save keeps line breaks, tasks, list numbers and bold next to spaces ([12b278d](https://github.com/linjiejim/greenhouse/commit/12b278ddee7eb71f5a0c1121f61accd1ced57adf))
* **knowledge-editor:** code blocks keep their length across saves, and the editor is a named text box ([4581edc](https://github.com/linjiejim/greenhouse/commit/4581edc6dc1754f06ee0c1ccb86c90a6315a9db2))
* **mcp:** a connector nobody has connected is offered right after install ([f383346](https://github.com/linjiejim/greenhouse/commit/f3833469320914cdd78225d6f229d169260a809c))
* **mobile:** a Bots thread holds still while it replies; cards open to decide ([90cfccb](https://github.com/linjiejim/greenhouse/commit/90cfccb8ba10ed1655d6f159cde4f792b414133a))
* **mobile:** a conversation that loads empty greets like a new one ([fca4b75](https://github.com/linjiejim/greenhouse/commit/fca4b75149fda388d0d5a9c905e5d3ef796320f7))
* **mobile:** align native interactions and accessibility ([fc0cf6d](https://github.com/linjiejim/greenhouse/commit/fc0cf6d2ee11cf119c430831072710ef2de170d4))
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
* **mobile:** load the first conversation under the launch splash ([#58](https://github.com/linjiejim/greenhouse/issues/58)) ([7b5cb6c](https://github.com/linjiejim/greenhouse/commit/7b5cb6cdf2a1f78d141a9c9b59d005404fa4f843))
* **mobile:** make Bots forms and cards work with VoiceOver and large text ([9f5b1d2](https://github.com/linjiejim/greenhouse/commit/9f5b1d2a0c553418931a673a545005a391372a56))
* **mobile:** never send one station's token to another station's address ([cd51be6](https://github.com/linjiejim/greenhouse/commit/cd51be6a4428a6eb38bf8cc4602c3948a39d8f2f))
* **mobile:** New Chat leaves a thread restored on a cold start ([dfae23a](https://github.com/linjiejim/greenhouse/commit/dfae23a2ba236692ed281d66e98c02e6f5f7f075))
* **mobile:** no "Save Password?" or crash when a Bots sign-in sheet closes ([1f448f8](https://github.com/linjiejim/greenhouse/commit/1f448f82cac81f40fd5bd2f64fa75fc56f7fec42))
* **mobile:** only send the token with this station's chat files; steady Bots sign-in ([9ecc142](https://github.com/linjiejim/greenhouse/commit/9ecc142243079f62a4afc65753adff1edcca3b44))
* **mobile:** polish chat, widgets and agent reply behavior ([#66](https://github.com/linjiejim/greenhouse/issues/66)) ([7cf192b](https://github.com/linjiejim/greenhouse/commit/7cf192be93dfa659c8292021ea6009da8231088a))
* **mobile:** recover from unreachable stations without blank screens ([#68](https://github.com/linjiejim/greenhouse/issues/68)) ([b0cec26](https://github.com/linjiejim/greenhouse/commit/b0cec262980001539e850ac10d29c2dd52fb7735))
* **mobile:** reflow mounted text when the system text size changes ([ac2ddb7](https://github.com/linjiejim/greenhouse/commit/ac2ddb7c1437f1c5bf2bfc0e22b84e0031161d99))
* **mobile:** scope shared-note editors to navigation ([9e074d4](https://github.com/linjiejim/greenhouse/commit/9e074d4ef0457a369e23b102c9ecc7dbfefee3e9))
* **mobile:** send tokens and refreshes only to the active station ([5521a5a](https://github.com/linjiejim/greenhouse/commit/5521a5aa0be5585f28d428dad705c5ed18bbda3d))
* **mobile:** steadier Bots sheets and cards ([47a82d2](https://github.com/linjiejim/greenhouse/commit/47a82d2a314b66c8246dc359bcbd68b6fd780c21))
* **mobile:** what the simulator walk-through found ([92113ef](https://github.com/linjiejim/greenhouse/commit/92113efca13c9d30f863d9517ee51a5b0f2f1852))
* **rich-output:** harden the html-preview bridge and close the [#43](https://github.com/linjiejim/greenhouse/issues/43) review notes ([#45](https://github.com/linjiejim/greenhouse/issues/45)) ([bccb2fc](https://github.com/linjiejim/greenhouse/commit/bccb2fc4c20c8ce4256ef7276ff1681885c2e7e8))
* **security:** treat IPv4-mapped IPv6 addresses written in hex as private ([08c9bd8](https://github.com/linjiejim/greenhouse/commit/08c9bd85dd5b1ceb4d03c59ac79f3bfbba55d941))
* **site:** make launch screenshots readable ([9e6b630](https://github.com/linjiejim/greenhouse/commit/9e6b63042237d4781114695599423a6978d941f1))
* **site:** refresh captures after server copy spacing fix ([cd03a79](https://github.com/linjiejim/greenhouse/commit/cd03a79c02dda1ea1678d5aa4f129be41a5a3cc4))
* **tables:** records made together keep their order ([f7088f8](https://github.com/linjiejim/greenhouse/commit/f7088f8d94bf8b74c166235a7c8de06db6614197))
* **ui:** a menu stays open when something else scrolls ([b631cb6](https://github.com/linjiejim/greenhouse/commit/b631cb684f4936ea4160ed689e0f6abd88dbb262))
* **ui:** a picker no longer closes itself while its drawer settles ([0d9ccb1](https://github.com/linjiejim/greenhouse/commit/0d9ccb14fc73a8f5072892dbd3707342f5f93dd6))
* **ui:** align web interactions and decision copy ([689db60](https://github.com/linjiejim/greenhouse/commit/689db60a81ac0eda6f6c041b61dabe8aaadfa86c))
* **ui:** integrate request lifecycle with polished cards ([58d0647](https://github.com/linjiejim/greenhouse/commit/58d0647d87b3678186045d44108c80ad00d60d38))
* **ui:** pickers stay open when a scroll keeps their anchor in view ([45b4f61](https://github.com/linjiejim/greenhouse/commit/45b4f61e6be9ba3d037898e8a1b36911651a3650))
* **ui:** polish web and native conversations and surfaces ([831ded1](https://github.com/linjiejim/greenhouse/commit/831ded15106dccb12662d0ba9dcf7c1b018b3466))
* **web:** a doc keeps its draft through refresh errors, saves only what changed and waits for pictures ([18eeb3b](https://github.com/linjiejim/greenhouse/commit/18eeb3b7c0f75138c0630c311349632ea5845461))
* **web:** a picked mention puts the caret after it before the next key ([5116ad3](https://github.com/linjiejim/greenhouse/commit/5116ad3804fea768431f4f1c22a85ef98349363a))
* **web:** Back no longer drops unsaved doc edits ([490fadc](https://github.com/linjiejim/greenhouse/commit/490fadc83f9d10b1d779b21779401aab10cccd51))
* **web:** catching up keeps what arrived meanwhile; a reconnect stays light ([7888542](https://github.com/linjiejim/greenhouse/commit/7888542411f9dab7c6bffabedaecce4604947fd9))
* **web:** equip skills in one version, and keep pages mounted across tab changes ([d64914b](https://github.com/linjiejim/greenhouse/commit/d64914b6ca3fb0d980cad88635d230c05cd3204a))
* **web:** knowledge lists page through 显示更多, drags into the team space ask first ([7d10353](https://github.com/linjiejim/greenhouse/commit/7d10353044c5ba928057f5083941ec2b617c8b7f))
* **web:** knowledge pages on phones, drops that end cleanly, and the Agent's folder in the browser tests ([64eae7a](https://github.com/linjiejim/greenhouse/commit/64eae7a58e2c4f71e998323c17b4d9daedf87d9d))
* **web:** name approval objects and defer large modules ([9850f48](https://github.com/linjiejim/greenhouse/commit/9850f48849bc61d71eab7b951c207f1f11176991))
* **web:** polish v2 interactions and stabilize regression checks ([8f571ea](https://github.com/linjiejim/greenhouse/commit/8f571ea5fa22c15895d5496d7abcae27a5e4462c))
* **web:** sanitize exported answers and sandbox the PDF print frame ([#44](https://github.com/linjiejim/greenhouse/issues/44)) ([e544c09](https://github.com/linjiejim/greenhouse/commit/e544c099a6872ff76d39069f20265df80b011c08))
* **web:** show which external tool an MCP call reached ([dd02189](https://github.com/linjiejim/greenhouse/commit/dd02189684f3ed50347c95620f648be1aa00da95))
* **web:** the main Agent's page shows a save at once ([aa498d1](https://github.com/linjiejim/greenhouse/commit/aa498d166b222b21b688cb3dbad581c478121b57))
* **web:** the OAuth consent screen no longer re-renders forever ([48588f0](https://github.com/linjiejim/greenhouse/commit/48588f0bb653bbbb74debdb86f5b0b8bedfef01b))


### Changed

* **agent-core:** the loop takes a resolved model; the v1 model registry is gone ([93cbf2c](https://github.com/linjiejim/greenhouse/commit/93cbf2cb7d99b0af592229d520b4d19c8186538c))
* **mobile:** delete the v1 app and bring mobile back into the root tests ([7d663d1](https://github.com/linjiejim/greenhouse/commit/7d663d1ee1e7e4e68d685e8e1204fd39be197e3c))
* **mobile:** drop the cross-conversation capsule, the home bridge and the Bot shelf ([cd92d7b](https://github.com/linjiejim/greenhouse/commit/cd92d7ba6628271a3d7fc027c66e88bfe3bc0c9d))
* **v2:** remove the v1 application from the v2 branch ([d8b0421](https://github.com/linjiejim/greenhouse/commit/d8b0421417e43db95955dfb0202b4e8c45fe6140))
* **web:** the doc editor loads only when someone edits ([c1026e6](https://github.com/linjiejim/greenhouse/commit/c1026e6d6a57b51461b76e8a0b1f8d4ef23a6b17))

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
