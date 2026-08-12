/**
 * Deliver annotations to a generic webhook when configured.
 *
 * F8 (element threads and webhook handoff): the delivered body is one
 * bounded JSON event (schema "annotation.thread.v1") rather than the raw
 * annotation, so Slack- and Linear-compatible receivers get exactly the
 * thread context they render: annotation id, thread id, parent id, page
 * URL, element selector, intent, severity, the committed instruction, the
 * reply text (mirrors the instruction for replies, so receivers can branch
 * on parentId without re-reading the instruction), and the local share URL
 * when derivable. Legacy annotations without thread fields still deliver:
 * threadId and parentId are null and every other field is read the same
 * way, so no annotation is ever dropped from webhook delivery.
 */

import * as path from "node:path";
import { logError } from "../schema.ts";

const DEFAULT_TIMEOUT_MS = 5_000;

// Never send webhook bodies over this cap; oversized annotations are skipped
// and logged to the shared error log instead of pushing megabytes at the hook.
const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

// The hub binds 127.0.0.1:8787 by default; BROWSERLINK_HUB_URL overrides the
// base used to build the local share URL in the event (same env the MCP
// client uses to reach the hub).
const DEFAULT_HUB_BASE = "http://127.0.0.1:8787";

export type ThreadEventPayload = {
  event: "annotation.thread.v1";
  annotationId: string | null;
  threadId: string | null;
  parentId: string | null;
  url: string | null;
  title: string | null;
  selector: string | null;
  tag: string | null;
  intent: string | null;
  severity: string | null;
  instruction: string | null;
  replyText: string | null;
  shareUrl: string | null;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Build the bounded thread event for one stored annotation. Pure function of
 * (annotation, annotationPath, env): identical inputs always produce the
 * identical event, so webhook bodies are deterministic per annotation.
 *
 * Field rules (documented in docs/rest.md):
 * - instruction is this annotation's element instruction (the committed
 *   text; for a reply item this IS the reply body).
 * - replyText is present only on replies (parentId set) and mirrors the
 *   instruction, so receivers can render the reply body without re-reading
 *   the instruction field; root events carry null.
 * - shareUrl is `<hub base>/annotations/<stored name>/share` when the stored
 *   name is derivable (annotationPath wins over annotation.id), else null.
 */
export function threadEventPayload(
  annotation: Record<string, unknown>,
  annotationPath?: string,
): ThreadEventPayload {
  const annotationId =
    stringOrNull(annotation.id) ??
    (annotationPath ? path.basename(annotationPath, ".json") : null);
  const threadId = stringOrNull(annotation.threadId);
  const parentId = stringOrNull(annotation.parentId);
  const url = stringOrNull(annotation.url);
  const title = stringOrNull(annotation.title);

  const elements = Array.isArray(annotation.elements)
    ? (annotation.elements as unknown[])
    : [];
  const element =
    elements[0] !== null &&
    typeof elements[0] === "object" &&
    !Array.isArray(elements[0])
      ? (elements[0] as Record<string, unknown>)
      : null;
  const selector =
    element && typeof element.cssPath === "string" && element.cssPath
      ? element.cssPath
      : null;
  const tag = stringOrNull(element?.tag);
  const intent = stringOrNull(element?.intent);
  const severity = stringOrNull(element?.severity);
  const instruction = stringOrNull(element?.instruction);

  const storedName = annotationPath
    ? path.basename(annotationPath)
    : annotationId
      ? `${annotationId}.json`
      : null;
  let shareUrl: string | null = null;
  if (storedName) {
    const base = String(process.env.BROWSERLINK_HUB_URL ?? DEFAULT_HUB_BASE)
      .replace(/\/+$/, "");
    shareUrl = `${base}/annotations/${storedName}/share`;
  }

  return {
    event: "annotation.thread.v1",
    annotationId,
    threadId,
    parentId,
    url,
    title,
    selector,
    tag,
    intent,
    severity,
    instruction,
    replyText: parentId !== null ? instruction : null,
    shareUrl,
  };
}

export async function register(
  annotation: Record<string, unknown>,
  annotationPath?: string,
): Promise<void> {
  // The webhook URL is required: the hub only registers this adapter when
  // BROWSERLINK_WEBHOOK_URL is set, and a direct call without it is skipped.
  const endpoint = process.env.BROWSERLINK_WEBHOOK_URL;
  if (!endpoint) {
    return;
  }

  const body = JSON.stringify(threadEventPayload(annotation, annotationPath));
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
