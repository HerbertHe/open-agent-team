# 每日自动发布

`.github/workflows/daily-release.yml` 负责 CLI 和 Desktop 的统一版本与发布。

## 触发规则

- 每次提交到 `main` 都会在 Linux、Windows 和 macOS 上构建 Desktop，并保存 14 天的 Actions 构建产物。
- 每天北京时间 18:00（GitHub cron `10:00 UTC`）创建当天唯一正式版本。
- 如果定时任务未执行或失败，18:00 后当天第一次提交到 `main` 会尝试补发。
- `workflow_dispatch` 可以手动补发；已正式发布的当天版本不会重复发布，失败留下的草稿会继续补齐。

## 版本格式

- GitHub Release 与 Git tag：`vYYYY.MM.DD`，例如 `v2026.08.28`。
- npm、CLI 和 Desktop `package.json`：`YYYY.M.D`，例如 `2026.8.28`。

npm 要求 `package.json.version` 能被 `node-semver` 解析；SemVer 数字段不接受 `08` 这样的前导零，因此 npm 内部版本不能直接使用补零日期。两个形式表达同一个发布日期。

正式发布前，工作流会同步修改根目录和 Desktop 的 `package.json`，并向 `main` 提交：

```text
chore(release): YYYY.MM.DD [skip ci]
```

## 仓库配置

需要在 GitHub 仓库中配置：

1. Actions 的 `GITHUB_TOKEN` 具有 `contents: write` 权限。
2. `main` 分支规则允许 `github-actions[bot]` 写入每日版本提交，或为该工作流配置相应的绕过权限。
3. Repository secret `NPM_TOKEN`，拥有发布 `open-agent-team` 的权限。

正式发布顺序为：

1. 计算北京时间日期并检查当日 tag。
2. 同步 CLI 与 Desktop 版本并提交到 `main`。
3. 构建 Linux AppImage、Windows NSIS 和 macOS DMG。
4. 构建并发布 npm CLI；已存在的当日 npm 版本会被安全跳过。
5. 生成 `SHA256SUMS.txt`。
6. 创建 GitHub Release 草稿、上传所有 Desktop 安装包，上传成功后再正式发布。失败留下的草稿可由后续触发安全重试。
