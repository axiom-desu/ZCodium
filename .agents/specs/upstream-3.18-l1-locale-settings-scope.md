# Upstream 3.18.2 L1: locale and settings-scope consumer parity

## Scope and ownership

- Supported locale identity, BCP-47 resolution, native names, settings migration compatibility, and the selected locale preference remain owned by the existing shared protocol / setting service / `ZCodeIntlProvider`; this slice adds `ja-JP`, `ko-KR`, and `ru-RU` without changing `en-US` or `zh-CN` ownership.
- New locale messages are partial overlays on English. Existing U1/U2/U3/U4 key additions remain intact and fall back to English; no giant locale source file or max-lines waiver is allowed.
- Existing settings scope owner resolves the selected device/workspace service. Remote configuration reads/writes stay on that device's source-settings attachment; mobile remains denied. This slice only connects existing settings-scope consumers and routes legacy sync intents into the existing DataSync dialog request owner at WindowRoot. No second dialog/provider/owner.
- Host vs Source semantics stay distinct: only remote **user** scope uses source-settings; workspace scope uses its workspace Host. A missing/old remote capability remains explicit/unsupported rather than empty success. Do not expand phone RPC allowlists.

## Event order

```text
settings service / system locale -> ZCodeIntlProvider -> locale message overlay + Intl formatting
user selects locale -> existing settingService update -> existing cross-window broadcast
legacy remote-sync intent -> existing DataSync request store -> one WindowRoot DataSyncDialogHost
settings scope selection -> management snapshot + config workspace catalog -> existing source-settings or workspace service
```

## Acceptance

- Locale selector contains system + all five supported locales; system language resolution recognizes Chinese/Japanese/Korean/Russian and otherwise English.
- Locale is persisted through the existing setting service and transmitted as the selected BCP-47 locale; old settings migration remains backward compatible.
- New localized keys override English, and keys added only to current English fall back to English.
- Settings-scope consumers preserve local/remote user and workspace distinctions, offline fail-closed behavior, and mobile denial.
- Legacy synchronization entry points request the existing unified DataSync dialog; there is one dialog owner mounted for the window lifetime.
- Locale data files remain <=400 lines; tests cover fallback, locale persistence/request header, and scope routing with in-memory services; Chromium language choice/compact layout smoke when feasible.
