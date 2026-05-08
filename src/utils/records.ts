/**
 * Agent 工作过程文件的固定目录名及路径工具。
 *
 * - CHANGELOG.md 始终在工作区根目录
 * - 其他工作过程文件（笔记、草稿、日志、中间产出等）存放在 records/yyyy-MM-dd/ 下
 */

/** 工作过程文件存放的固定子目录名（不可配） */
export const RECORDS_DIR = "records";

/**
 * 返回当天的 records 子路径：`records/yyyy-MM-dd`
 */
export function todayRecordsSubPath(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${RECORDS_DIR}/${yyyy}-${mm}-${dd}`;
}
