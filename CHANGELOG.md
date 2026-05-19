# Changelog

## [0.19.0](https://github.com/genkio/slop-review/compare/v0.18.0...v0.19.0) (2026-05-19)


### Features

* resume from last visited view ([fa1a737](https://github.com/genkio/slop-review/commit/fa1a7374f3500dc45671af4770fc308c60386ca2))
* resume on unresolved-only ([9076bc1](https://github.com/genkio/slop-review/commit/9076bc11f2ee5359e097201effc0b0a7af09b399))

## [0.18.0](https://github.com/genkio/slop-review/compare/v0.17.0...v0.18.0) (2026-05-16)


### Features

* more vim bindings ([b3309c3](https://github.com/genkio/slop-review/commit/b3309c3ae8e274ee6aa77f35b346d122bf215a5e))
* peek HEAD for commit-view lines with later changes ([b17b290](https://github.com/genkio/slop-review/commit/b17b29091214ae9a2e14ca533e0c094a7792de67))
* vim binding for jump between threads ([2026fd0](https://github.com/genkio/slop-review/commit/2026fd0962afc7075cd7ce824b9532611a59acfd))

## [0.17.0](https://github.com/genkio/slop-review/compare/v0.16.0...v0.17.0) (2026-05-15)


### Features

* dynamic page title ([8974ed1](https://github.com/genkio/slop-review/commit/8974ed1634eff4dd616d867a7a97d18b0782c936))
* generate overview with claude code cli ([272a1e4](https://github.com/genkio/slop-review/commit/272a1e4fc3b5e2984677f6a4489b23c20a46f8f3))
* generate overview with claude code cli ([cc0196a](https://github.com/genkio/slop-review/commit/cc0196abc124b03ae7fe14ece5c68a8eb0d4b303))
* vim mode ([be266a0](https://github.com/genkio/slop-review/commit/be266a0a2c41a7817f56c6192ae293c9e310bca9))

## [0.16.0](https://github.com/genkio/slop-review/compare/v0.15.0...v0.16.0) (2026-05-14)


### Features

* 'later changes' sticky file head ([36ad321](https://github.com/genkio/slop-review/commit/36ad321846f40fee7090a4af2267f0d69707f2a4))
* all threads resolved indicator ([cd36ab7](https://github.com/genkio/slop-review/commit/cd36ab7548c1ed0111eb333d355d9ecd4e68f269))
* copy diff ([875436f](https://github.com/genkio/slop-review/commit/875436fad4ea2c24914c839c045009355f5b96c6))

## [0.15.0](https://github.com/genkio/slop-review/compare/v0.14.0...v0.15.0) (2026-05-14)


### Features

* deeplink to github ([f3f7e48](https://github.com/genkio/slop-review/commit/f3f7e4820c81a3ef3279d07333b3b6b592c434e0))

## [0.14.0](https://github.com/genkio/slop-review/compare/v0.13.1...v0.14.0) (2026-05-14)


### Features

* copy lines ([192cf0d](https://github.com/genkio/slop-review/commit/192cf0d5fb7586c3e344adc0c05ae7b82f8ddc08))

## [0.13.1](https://github.com/genkio/slop-review/compare/v0.13.0...v0.13.1) (2026-05-14)


### Bug Fixes

* minor open thread issues ([fbcadc3](https://github.com/genkio/slop-review/commit/fbcadc35d223f1e6d04f6f973329f0549eec93cc))
* use per-branch namespacing to persist cursor position ([9f448e2](https://github.com/genkio/slop-review/commit/9f448e2f66407d203020f1d39a5adf475321c362))

## [0.13.0](https://github.com/genkio/slop-review/compare/v0.12.0...v0.13.0) (2026-05-14)


### Features

* auto switch view ([5f68a5d](https://github.com/genkio/slop-review/commit/5f68a5d1096805052bbc5d59bd3a588bb79d1fcb))
* persist ui state ([6cd5a49](https://github.com/genkio/slop-review/commit/6cd5a49a9008e7a879f50f97040e7117819851e6))

## [0.12.0](https://github.com/genkio/slop-review/compare/v0.11.0...v0.12.0) (2026-05-13)


### Features

* auto mark on last resolved ([80d565e](https://github.com/genkio/slop-review/commit/80d565eb68c5f19360e9f6fbeb3990e5cc4503ff))
* per-comment editing ([90dbaa0](https://github.com/genkio/slop-review/commit/90dbaa0565271d490ac7f38b0d5375a19f9e5f39))
* per-file blob keyed reviewed marks ([3765b71](https://github.com/genkio/slop-review/commit/3765b71d1854a391104ece7be4841255d4f6a95b))
* persisted toast ([89d6c71](https://github.com/genkio/slop-review/commit/89d6c71376ab4daace257145ba936c8d73c741ec))
* review on main/master without a feature branch ([1e887cd](https://github.com/genkio/slop-review/commit/1e887cdc6459bf61d2c532cd8d13cd01356bb3b7))


### Bug Fixes

* clear reviewed marks logic ([59990af](https://github.com/genkio/slop-review/commit/59990af4e0c370c07668a0cc94729050dd93cf8d))
* restore multi-line comment selection ([e29bad1](https://github.com/genkio/slop-review/commit/e29bad14a7f8ada7c515132acc601b3d35652b77))
* sticky file path head position ([d0e4450](https://github.com/genkio/slop-review/commit/d0e44504fba5b2c546aecbcdc58d5f023df6446b))

## [0.10.0](https://github.com/genkio/slop-review/compare/v0.9.0...v0.10.0) (2026-05-11)


### Features

* tighter thread → diff round-trip ([512da4c](https://github.com/genkio/slop-review/commit/512da4c5d1f50aaed3543f6c17160d71fc206b78))


### Bug Fixes

* **diff:** drop redundant body dim on reviewed files ([32b357f](https://github.com/genkio/slop-review/commit/32b357f87828f91d1f1624af05e1b7dfc512bd70))

## [0.9.0](https://github.com/genkio/slop-review/compare/v0.8.0...v0.9.0) (2026-05-11)


### Features

* multi-line comment ([7b36d88](https://github.com/genkio/slop-review/commit/7b36d88073133c4f162acb7656a8f02d47bc104a))
* one-click jump back to origin symbol ([ecfe828](https://github.com/genkio/slop-review/commit/ecfe828275763a2e49f841479cab2e464084c0bd))
* per-file comments count badge ([0c3824e](https://github.com/genkio/slop-review/commit/0c3824ec40dea8caa780eda24d7c2c185c0205dc))


### Bug Fixes

* symbol highlight ([228efc2](https://github.com/genkio/slop-review/commit/228efc2318945a5da9ea6e4bfdced9b490795342))


### Performance Improvements

* **diff:** snappier hydration and mark-reviewed toggle ([916be7c](https://github.com/genkio/slop-review/commit/916be7cc58829aa0a5768bdd86c9188a9e3391df))

## [0.8.0](https://github.com/genkio/slop-review/compare/v0.7.0...v0.8.0) (2026-05-10)


### Features

* surface skill install via dismissable banner ([2533270](https://github.com/genkio/slop-review/commit/2533270cc5cd57981f0c4e7107e5014ededd68a7))

## [0.7.0](https://github.com/genkio/slop-review/compare/v0.6.0...v0.7.0) (2026-05-10)


### Features

* codex-generated branch overview page ([7616635](https://github.com/genkio/slop-review/commit/76166357d4d3d0cc0eddc7ed3360c5f0787a400f))
* delta-style within-line diff highlighting ([07784a1](https://github.com/genkio/slop-review/commit/07784a1b2488a44883527840171c7ee461e9b1ff))
* delta-style within-line diff highlighting ([ae50b39](https://github.com/genkio/slop-review/commit/ae50b395872e08caff3974b6c399cd361f18ad15))
* overlay-style symbol side panel with multi-search parking ([73957ff](https://github.com/genkio/slop-review/commit/73957ff5c9f3ebaa11fbd1933a72eb01777d74e5))
* render added/removed files inline regardless of split toggle ([f21340d](https://github.com/genkio/slop-review/commit/f21340de7d311d2015bfd2f59c3c636021126c18))
* replace aggregated-prompt ui with skills ([120badb](https://github.com/genkio/slop-review/commit/120badbab0aa7cfb764cf07a5d07bb592d9d5f94))
* resolve thread ([af83c9d](https://github.com/genkio/slop-review/commit/af83c9dc97ea032af2b8308013c8beba38ed4080))
* ship as npm package ([269fd55](https://github.com/genkio/slop-review/commit/269fd55d6eabe631cd608f698ad66eaaa8ce27e9))
* symbol matches with jump stacks and highlight ([503eb30](https://github.com/genkio/slop-review/commit/503eb30beeff45aeb4fcd3d0d9e5401727fe94c5))


### Bug Fixes

* **pkg:** declare repository url for npm provenance ([31e339e](https://github.com/genkio/slop-review/commit/31e339efff9fed742419dfa3783d0067da0760d4))
* stabilize symbol navigation ([5e82e48](https://github.com/genkio/slop-review/commit/5e82e482235ff0579e9ab39c4c446dde159a296c))
* **state:** serialize writes and use unique temp paths ([6f630eb](https://github.com/genkio/slop-review/commit/6f630eb8ccd487f71a284a8615daae287b93b830))

## [0.5.0](https://github.com/genkio/slop-review/compare/v0.4.0...v0.5.0) (2026-05-08)


### Features

* delta-style within-line diff highlighting ([07784a1](https://github.com/genkio/slop-review/commit/07784a1b2488a44883527840171c7ee461e9b1ff))
* delta-style within-line diff highlighting ([ae50b39](https://github.com/genkio/slop-review/commit/ae50b395872e08caff3974b6c399cd361f18ad15))

## [0.4.0](https://github.com/genkio/slop-review/compare/v0.3.1...v0.4.0) (2026-05-07)


### Features

* codex-generated branch overview page ([7616635](https://github.com/genkio/slop-review/commit/76166357d4d3d0cc0eddc7ed3360c5f0787a400f))

## [0.3.1](https://github.com/genkio/slop-review/compare/v0.3.0...v0.3.1) (2026-05-07)


### Bug Fixes

* stabilize symbol navigation ([5e82e48](https://github.com/genkio/slop-review/commit/5e82e482235ff0579e9ab39c4c446dde159a296c))

## [0.3.0](https://github.com/genkio/slop-review/compare/v0.2.2...v0.3.0) (2026-05-07)


### Features

* symbol matches with jump stacks and highlight ([503eb30](https://github.com/genkio/slop-review/commit/503eb30beeff45aeb4fcd3d0d9e5401727fe94c5))

## [0.2.2](https://github.com/genkio/slop-review/compare/v0.2.1...v0.2.2) (2026-05-05)


### Bug Fixes

* **state:** serialize writes and use unique temp paths ([6f630eb](https://github.com/genkio/slop-review/commit/6f630eb8ccd487f71a284a8615daae287b93b830))
