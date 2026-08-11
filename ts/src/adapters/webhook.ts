/**
 * Deliver annotations to a generic webhook when configured.
 */

import { logError } from "../schema.ts";

const DEFAULT_TIMEOUT_MS = 5_000;

// Never send webhook bodies over this cap; oversized annotations are skipped
// and logged to the shared error log instead of pushing megabytes at the hook.
const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

export async function register(annotation: Record<string, unknown>): Promise<void> {
  // The webhook URL is required: the hub only registers this adapter when
  // BROWSERLINK_WEBHOOK_URL is set, and a direct call without it is skipped.
  const endpoint = process.env.BROWSERLINK_WEBHOOK_URL;
  if (!endpoint) {
    return;
  }

  const body = JSON.stringify(annotation);
  const bytes = Buffer.byteLength(body, "utf8");
  const annotationId =
    typeof annotation.id === "string" && annotation.id ? annotation.id : null;
  if (bytes > MAX_WEBHOOK_BODY_BYTES) {
    logError({
      adapter: "webhook",
      annotationId,
      sessionId: null,
      error: `payload ${bytes} bytes exceeds ${MAX_WEBHOOK_BODY_BYTES} byte cap; skipping delivery`,
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      logError({
        adapter: "webhook",
        annotationId,
        sessionId: null,
        error: `HTTP ${response.status} from ${endpoint}`,
      });
    }
  } catch (error) {
    logError({
      adapter: "webhook",
      annotationId,
      sessionId: null,
      error: `network failure: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    clearTimeout(timer);
  }
}
