export interface WebhookPayload {
  event: "upstream_down" | "upstream_up";
  host: string;
  upstream: string;
  group: string | null;
  timestamp: string;
  response_ms: number | null;
  message: string;
}

export async function sendWebhook(
  url: string,
  payload: WebhookPayload
): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    console.error(
      `[watchdog] Failed to send webhook to ${url}:`,
      err instanceof Error ? err.message : err
    );
  }
}
