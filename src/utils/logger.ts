export class Logger {
  info(msg: string, extra?: Record<string, unknown>): void {
    console.log(`[INFO] ${msg}`, extra ?? "");
  }
  warn(msg: string, extra?: Record<string, unknown>): void {
    console.warn(`[WARN] ${msg}`, extra ?? "");
  }
  error(msg: string, extra?: Record<string, unknown>): void {
    console.error(`[ERROR] ${msg}`, extra ?? "");
  }
}

export const logger = new Logger();
