import chalk from "chalk";
function formatExtra(extra) {
    if (extra == null || Object.keys(extra).length === 0) {
        return "";
    }
    return ` ${JSON.stringify(extra)}`;
}
export class Logger {
    info(msg, extra) {
        console.log(`${chalk.blue("[INFO]")} ${msg}` + formatExtra(extra));
    }
    warn(msg, extra) {
        console.warn(`${chalk.hex("#FF9800")("[WARN]")} ${msg}` + formatExtra(extra));
    }
    error(msg, extra) {
        console.error(`${chalk.red("[ERROR]")} ${msg}` + formatExtra(extra));
    }
    success(msg, extra) {
        console.log(`${chalk.green("[SUCCESS]")} ${msg}` + formatExtra(extra));
    }
}
export const logger = new Logger();
