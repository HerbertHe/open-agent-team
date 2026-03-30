import net from "node:net";

const DEFAULT_HOST = "127.0.0.1";

/** 尝试在 host 上监听该端口；成功则关闭并视为可用。 */
export function isPortAvailable(port: number, host = DEFAULT_HOST): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (err: NodeJS.ErrnoException) => {
      server.close();
      if (err.code === "EADDRINUSE") resolve(false);
      else reject(err);
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * 自 startPort 起寻找最小 base，使 base..base+length-1 均可绑定（与 opencode serve 监听同一地址一致）。
 * 若在 [startPort, startPort+maxScan-length] 内找不到则返回 null。
 */
export async function findContiguousAvailablePorts(
  startPort: number,
  length: number,
  maxScan: number
): Promise<number | null> {
  if (length <= 0) throw new Error("length must be positive");
  if (maxScan < length) return null;
  const upper = startPort + maxScan - length;
  for (let base = startPort; base <= upper; base++) {
    let allFree = true;
    for (let i = 0; i < length; i++) {
      if (!(await isPortAvailable(base + i))) {
        allFree = false;
        break;
      }
    }
    if (allFree) return base;
  }
  return null;
}
