import type { RuntimeProvider } from "./interface";
import { t } from "../i18n/i18n";

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
  throw new Error(t("runtime_ready_timeout", { port, timeoutMs }));
}
