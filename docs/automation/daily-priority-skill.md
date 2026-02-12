# Daily Priority Skill（本地运行版）

目标：每天一条命令拿到今天先做什么、后做什么。

## 触发词建议

- `today priorities`
- `今日任务优先级`
- `今天先做什么`

## Skill 行为定义

1. 执行 `pnpm task:today`
2. 读取脚本输出中的三段：
   - 今日 Top 3（必须做）
   - 次优先级候选（有余力再做）
   - 建议延后项
3. 用 3~6 行总结今日执行顺序，不改写优先级层级（`p0 > p1 > p2 > p3`）

## 失败处理

- 若 GitHub API 拉取失败：提示检查 `gh auth status`
- 若 AI Provider 失败：继续输出规则排序结果（不报错退出）

## 本地前置条件

1. 已安装并登录 GitHub CLI：`gh auth status`
2. 在仓库根目录执行命令
3. 如需 AI 同级排序，配置：
   - `RELEASE_NOTES_API_KEY`
   - `RELEASE_NOTES_MODEL`
   - `RELEASE_NOTES_API_BASE_URL`
   - `RELEASE_NOTES_API_PATH`
