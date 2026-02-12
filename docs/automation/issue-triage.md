# GitHub Issue 自动化分拣说明

本文档描述 `Issue Triage` 自动化的运行方式、配置项和本地使用方式。

## 1. 已落地内容

- Workflow: `.github/workflows/issue-triage.yml`
- 主脚本: `scripts/issue-triage.mjs`
- AI Provider 客户端: `scripts/lib/ai-provider-client.mjs`
- Todo 解析/生成: `scripts/lib/todo-parser.mjs`
- 每日优先级脚本: `scripts/local-daily-priority.mjs`

## 2. 调度策略

`issue-triage.yml` 内置三种调度：

1. 每 6 小时增量扫描（默认）
2. 每天 1 次全量扫描
3. 每 30 分钟恢复扫描（仅处理 `triage:needs-ai-retry`）

同时支持 `workflow_dispatch` 手动触发并选择 `incremental/full/retry`。

## 3. 标签策略

自动确保并使用以下标签：

- 现有：`bug`、`enhancement`、`duplicate`
- 新增：`priority:p0`、`priority:p1`、`priority:p2`、`priority:p3`
- 恢复队列：`triage:needs-ai-retry`
- 低置信重复候选：`duplicate-candidate`

## 4. 去重规则

1. 仅同类型去重（Bug 对 Bug，Feature 对 Feature）
2. 先规则相似度筛选（默认阈值 `0.78`）
3. 再调用 AI 判重
4. 满足高置信条件才自动关闭：
   - `is_duplicate = true`
   - `confidence >= 0.92`
   - 规则相似度 >= 0.78

## 5. 灰度与开关

`ISSUE_TRIAGE_DRY_RUN_CLOSE` 控制关闭行为：

- `true`：只评论 + 打标签，不执行关闭（灰度模式，默认）
- `false`：满足条件时自动关闭重复 Issue

建议先保持 `true` 跑 2 天，观察误判后再切 `false`。

## 6. AI 失败恢复

AI 请求重试策略默认：

- 第 1 次失败后等待 `30s`
- 第 2 次失败后等待 `2m`
- 第 3 次失败后等待 `8m`

仍失败会给对应 issue 打上 `triage:needs-ai-retry`，由 30 分钟恢复任务自动回补。

## 7. Todo 文件格式

自动维护文件：`docs/todo/issues.md`

固定区块：

- `P0 Blockers`
- `P1 Important Bugs`
- `P2 Features`
- `P3 Backlog`
- `Recently Closed as Duplicate`

每条待办包含：

- Issue 编号
- 标题
- 标签
- 排序理由
- Issue 链接

## 8. 本地每日优先级

命令：

```bash
pnpm task:today
```

行为：

1. 通过 GitHub API 拉取远端最新 `docs/todo/issues.md`
2. 按 `p0 > p1 > p2 > p3` 输出今日建议
3. 同级内若 AI 可用，会做二次排序；AI 失败自动降级规则排序

输出结构：

- 今日 Top 3（必须做）
- 次优先级候选（有余力再做）
- 建议延后项

## 8.1 本地安全演练（不改线上 Issue）

可用以下命令做只读演练：

```powershell
$env:ISSUE_TRIAGE_READONLY="true"
$env:ISSUE_TRIAGE_SKIP_GIT="true"
$env:ISSUE_TRIAGE_MODE="full"
node scripts/issue-triage.mjs
```

效果：

1. 会读取线上 issue 并生成本地 `docs/todo/issues.md`
2. 不会创建标签
3. 不会评论/关闭 issue
4. 不会提交和推送 git

## 9. 变量说明（Actions Variables/Secrets）

复用已有 Provider 变量：

- Secret: `RELEASE_NOTES_API_KEY`（或 `OPENAI_API_KEY`）
- Variable: `RELEASE_NOTES_MODEL`
- Variable: `RELEASE_NOTES_API_BASE_URL`
- Variable: `RELEASE_NOTES_API_PATH`

新增可选变量：

- `ISSUE_LOOKBACK_HOURS`（默认 `8`）
- `ISSUE_AI_TIMEOUT_MS`（默认 `30000`）
- `ISSUE_AI_RETRY_DELAYS_MS`（默认 `30000,120000,480000`）
- `ISSUE_DUPLICATE_CONFIDENCE`（默认 `0.92`）
- `ISSUE_DUPLICATE_SIMILARITY`（默认 `0.78`）
- `ISSUE_TRIAGE_DRY_RUN_CLOSE`（默认 `true`）
