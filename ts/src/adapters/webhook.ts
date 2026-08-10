/**
 * Deliver annotations to a generic webhook when configured.
 */

const DEFAULT_TIMEOUT_MS = 5_000;

export async function register(annotation: Record<string, unknown>): Promise<void> {
  const endpoint = process.env.BROWSERLINK_WEBHOOK_URL;
  if (!endpoint) {
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(annotation),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`Webhook adapter failed: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn(`Webhook adapter failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}
