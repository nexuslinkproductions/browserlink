# browserlink - Patch Notes v2.8.0

Released: 2026-08-13
Branch: feat/2.8.0-anchor-removal -> Development
Extension version: 2.3.0 | Hub version: 2.8.0 | Schema: v1.10

![Browserlink 2.8.0 Report](patch-notes/v2.8.0-report.png)

## Origin

Aura Scriptworks, a peer extension studio, left a Reddit comment challenging Browserlink to survive element removal, not only DOM drift. Browserlink turned that feedback into removal-aware anchoring in one production cycle. Removal is now a state transition, never data loss.

## Added

- **Removal-aware anchoring (F11).** Anchors now survive outright element removal rather than disappearing or attaching to arbitrary containers. A bounded document MutationObserver detects target removal, falls back to the nearest surviving ancestor (html/body excluded), or marks the entry detached while preserving its full quote and descriptor.
- **Detached drafts and remount recovery (F12).** In-progress element instructions and drafts survive target removal byte-for-byte as detached ghost markers. When matching content remounts, exact-match text resolution re-anchors the draft automatically without duplicate markers or observers.
- **Anchor honesty and diagnostics (F13).** Schema v1.10 exposes explicit `detached` resolution and `ancestor` fallback signal metadata in `elements[].anchor`, keeping markdown exports and diagnostic counters honest.

## Changed

- **Content-ready mutation batching.** Mutation-driven re-anchoring passes are debounced and coalesced with `requestAnimationFrame` on visible tabs, with a timeout fallback for hidden tabs.
- **Schema v1.10.** Extends `elements[].anchor` with `detached` resolution and `ancestor` fallback signal support, fully backward compatible with legacy annotations.

## Fixed

- iframe removal detection now resolves through the cached frame registry because Chrome nulls the live cross-document bridge before the observer callback (F11 follow-up);
- the attrs fallback tier requires matching text when stored text exists, ending silent fuzzy re-anchoring to changed content (F11 follow-up);
- the hidden-tab re-anchor fallback marks the pass only at execution, closing a first-frame/second-frame race (F11 follow-up);
- persistent drafts are keyed per tab so same-page tabs no longer share or overwrite each other's drafts (C6 isolation).

## Roadmap

1. **CSS Custom Highlight API rendering.** Removes injected-tag fragility, directly addresses sanitizer-hostile pages, and separates persistence from markup rendering.
2. **Transient versus permanent removal states.** Extends the anchor lifecycle so a modal close or temporary unmount can remain pending while a true disappearance becomes unanchored.
3. **"Try again" re-anchor action plus unanchored list view.** Gives users a low-effort recovery surface and makes explicit detached states visible and actionable.
