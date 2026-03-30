import type { RuntimeProvider } from "./interface";

/**
 * 轮询 {@link RuntimeProvider.health}，直到 opencode HTTP 可访问或超时。
 * 避免 spawn 后立即 fetch 出现 ECONNREFUSED。
 */
export async function waitForRuntimeReady(
  provider: RuntimeProvider,
  port: number,
  options?: { timeoutMs?: number; intervalMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const intervalMs = options?.intervalMs ?? 300;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await provider.health(port)) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timed out waiting for opencode HTTP on 127.0.0.1:${port} (${timeoutMs}ms). The process may have exited; ensure "opencode serve" runs and check workspace logs.`
  );
}
