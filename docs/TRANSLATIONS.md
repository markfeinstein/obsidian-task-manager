# Translations

> **Status:** English-only runtime with a partial localization workbench. Non-English catalogues are not selectable until they satisfy the localized-core and placeholder contract.

## Generated catalogue coverage

Coverage is the number of keys present in a locale catalogue divided by the English key count. It measures catalogue keys only—not every literal UI string, layout quality, grammar, plural completeness, or manual review.

| Locale | Keys | Catalogue coverage | Offered in picker |
|---|---:|---:|---|
| English (`en`) | 722 / 722 | 100% | Yes |
| Simplified Chinese (`zh`) | 134 / 722 | 19% | No; localized core incomplete |
| Spanish (`es`) | 90 / 722 | 12% | No; localized core incomplete |
| German (`de`) | 16 / 722 | 2% | No; localized core incomplete |
| Portuguese Brazil (`pt-BR`) | 15 / 722 | 2% | No; localized core incomplete |
| Korean, Vietnamese, Russian, Ukrainian, Belarusian | 0 / 722 | 0% | No; legacy stored values migrate to English |

The settings picker exposes only catalogues with 100% coverage of `LOCALIZED_CORE_KEYS` and exact placeholder parity. Partial catalogues remain in source for translation work, but are unavailable so the core journey never silently mixes a selected language with English fallback. Persisted unavailable locales normalize to English. Advanced surfaces outside the localized-core contract can still contain English literals, so no non-English locale is currently described as complete.
