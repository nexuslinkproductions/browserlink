# browserlink - Patch Notes v2.6.0

Released: 2026-08-12
Branch: feat/overnight-v2.6 → main (single PR)
Extension version: 2.1.0 | Hub version: 2.6.0 | Schema: v1.8

## Added

- **Share link.** Copy a link to any annotation from the popup and open a
  clean read-only page with the page URL, your notes, intent and priority
  chips, element instruction, and the screenshot. Everything is HTML-escaped
  and served with a locked-down CSP from your local hub. It is a local
  page, not a public link: same machine by default, LAN only if you
  deliberately expose the hub.
- **Deep element reach.** The picker now reaches inside open shadow roots and
  same-origin iframes, with honest shield labeling for cross-origin frames.
  No new permissions.
- **Anchor resilience.** If the page mutates after you picked an element,
  draft replay re-anchors via a deterministic fallback chain (stable
  attributes, text, position). Ambiguous cases stay unresolved instead of
  attaching to the wrong element.
- **Local save and backup.** Save the newest capture as PNG or JPEG,
  download the newest annotation as a portable bundle (JSON + AI brief +
  screenshot), or back up the whole local corpus as one deterministic ZIP.
  No uploads, no account, no cloud.
- **Onboarding.** First activation walks you through pick, instruct, send
  with three coach marks, and the popup offers session-wide always-on
  activation for research binges.

## Changed

- Schema v1.7/v1.8: optional per-element frame, shadow, and anchor metadata,
  fully backward compatible with legacy annotations.

## Fixed

- (none in this release)
