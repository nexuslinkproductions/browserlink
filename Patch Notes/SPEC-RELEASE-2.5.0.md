# browserlink — Patch Notes v2.5.0

Released: 2026-08-12
Branch: feat/overnight-v2.5 → main (single PR)
Extension version: 2.0.0 | Hub version: 2.5.0 | Schema: v1.6

## Fixed

- **Text formatting edits now validate end-to-end (schema v1.5).** The nine
  inspector-emitted text-format keys (textAlign, textTransform, letterSpacing,
  wordSpacing, whiteSpace, verticalAlign, textDecoration, fontStyle,
  textShadow) were rejected with HTTP 400 by the hub. They are now accepted,
  stored byte-for-byte, and delivered; unknown keys still fail strictly and
  legacy payloads remain fully compatible.

## Added

- **Intent and Priority per element (schema v1.6).** Element instructions now
  carry an optional intent (fix, change, question, approve) and severity
  (blocking, important, suggestion), set from compact chips in the element
  inspector and rendered as Intent/Priority labels in delivered messages.
  Wrong types and unknown enum values are rejected with HTTP 400; absent
  fields stay valid for backward compatibility.
- **Freeze State Capture.** A Freeze control pauses page animations while you
  annotate, so a capture holds the exact visual state. The stored annotation
  records whether animations were frozen, which element was hovered, which
  element was active, and which details/open elements were expanded at
  capture time.
- **Persistent Drafts.** In-progress strokes, notes, and element instructions
  survive a page refresh, keyed by canonical URL. Reload the page and your
  annotation draft is restored; sending clears the draft.
- **Copy AI Brief.** The popup and hub expose a deterministic Markdown brief
  of any stored annotation (page, label, notes, elements with instructions,
  edits, intent/priority, strokes, and file references) via
  GET /annotations/<name>/export.md, ready to paste into any AI harness.
- **docs/rest.md, docs/harnesses.md, docs/security.md** document the REST
  surface, harness integration, and privacy model.

## Changed

- Hub, schema, and MCP version tracks moved to 2.5.0; extension manifest to
  2.0.0. README badge and CHANGELOG updated to match.
- All delivery, capture, and draft paths verified end-to-end in a real
  browser (draw, pick, format, freeze, refresh-restore, send, composer
  attach, markdown export).

## Verified

- 67/67 deterministic tests pass; build, typecheck, extension syntax, and
  manifest checks exit 0.
- Live probes: formatted send 200, unknown-key 400, intent enum 400,
  severity type 400, legacy payload 200, export 200 text/markdown, missing
  export 404.
- Behavioral: real-user flows in an isolated Chrome instance, evidence
  captured per feature (see artifacts/FINAL/).
- Zero U+2014 em-dash characters across the repo.
