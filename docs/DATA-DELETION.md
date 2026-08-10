# User Data Deletion

Effective date: 2026-08-10

Browserlink is a local-first tool. It does not operate a cloud service and
does not store user data on servers operated by the project.

## What this means for deletion requests

Because browserlink has no server-side storage, there is nothing for the
project to delete on your behalf. All annotations, screenshots, element
data, and configuration live on your own machine.

## How to delete your data

- **Annotations and screenshots**: delete the local data directory. The
  default location is `~/.browserlink/annotations/` (or the directory set
  via `BROWSERLINK_DATA_DIR`). Removing that directory deletes every
  annotation and screenshot.
- **Extension state**: in your browser, go to `chrome://extensions`,
  find Browserlink, and click Remove. This deletes the extension and its
  stored settings.
- **Hub configuration**: stop the hub process and delete its data
  directory as described above.

## Data sent to third parties

When you send an annotation, it is delivered to the AI harness you have
configured. That service stores the data under its own terms; contact that
service to delete data it holds. Browserlink itself retains nothing.

## Contact

For deletion questions, open an issue on the repository at
https://github.com/nexuslinkproductions/browserlink.
