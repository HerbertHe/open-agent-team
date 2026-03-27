import chalk from "chalk";

function formatExtra(extra?: Record<string, unknown>): string {
  if (extra == null || Object.keys(extra).length === 0) {
    return "";
  }
  return ` ${JSON.stringify(extra)}`;
}

export class Logger {
  info(msg: string, extra?: Record<string, unknown>): void {
    console.log(`${chalk.blue("[INFO]")} ${msg}` + formatExtra(extra));
  }

  warn(msg: string, extra?: Record<string, unknown>): void {
    console.warn(chalk.hex("#FF9800")(`[WARN] ${msg}`) + formatExtra(extra));
  }

  error(msg: string, extra?: Record<string, unknown>): void {
    console.error(chalk.red(`[ERROR] ${msg}`) + formatExtra(extra));
  }

  success(msg: string, extra?: Record<string, unknown>): void {
    console.log(chalk.green(`[SUCCESS] ${msg}`) + formatExtra(extra));
  }
}

export const logger = new Logger();
