# AI Provider 复用指南

本文档记录 PaintBoard 当前的 AI 调用方式，方便在后续功能中复用（例如 Issue 整理、PR 摘要、变更归类）。

## 1. 当前已落地位置

- Release 工作流：`.github/workflows/release.yml`
- Release 摘要脚本：`scripts/generate-release-notes.mjs`

当前流程使用 OpenAI 兼容的 `chat/completions` 协议，但 API Base URL / Model / Key 全部可替换为第三方 Provider。

## 1.1 新增复用入口（Issue 自动化）

- `scripts/lib/ai-provider-client.mjs`
- `scripts/issue-triage.mjs`
- `scripts/local-daily-priority.mjs`

以上脚本与 release notes 使用同一组 Provider 变量，保持统一配置与重试策略。

## 2. 统一环境变量约定（建议复用）

以下变量已在 release 流程里使用，后续新脚本也建议沿用同名：

- `RELEASE_NOTES_API_KEY`：Provider API Key（放在 GitHub Repository Secret）
- `RELEASE_NOTES_MODEL`：模型名（放在 GitHub Repository Variable）
- `RELEASE_NOTES_API_BASE_URL`：API 基础地址（Variable）
- `RELEASE_NOTES_API_PATH`：接口路径（Variable），默认 `/v1/chat/completions`

兼容兜底变量（可选）：

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_API_BASE_URL`
- `OPENAI_API_PATH`

## 3. GitHub 配置位置

仓库页面：

1. `Settings`
2. `Secrets and variables`
3. `Actions`

添加：

- Repository Secret：`RELEASE_NOTES_API_KEY`
- Repository Variables：
  - `RELEASE_NOTES_API_BASE_URL`
  - `RELEASE_NOTES_API_PATH`
  - `RELEASE_NOTES_MODEL`

## 4. 请求协议模板（OpenAI 兼容）

```json
POST {RELEASE_NOTES_API_BASE_URL}{RELEASE_NOTES_API_PATH}
Authorization: Bearer {RELEASE_NOTES_API_KEY}
Content-Type: application/json

{
  "model": "gemini-3-flash-preview",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "stream": false,
  "temperature": 0.1
}
```

## 5. 输出治理（防止脏内容进入最终文案）

当前脚本的稳定策略，建议所有新场景复用：

1. 强约束输出格式：
   - 要求 AI 仅返回 JSON（不要 markdown，不要解释）
2. 过滤思考内容：
   - 过滤 `<think>...</think>`、`thinking/analysis/reasoning` 段落
3. 校验字段有效性：
   - 例如英文字段不允许出现中文字符
4. 回退机制：
   - AI 失败或输出不合规时，使用本地规则摘要，保证流程不失败

## 6. 复用到 Issue 整理（推荐方案）

可直接复用同一套 Provider 配置，新增脚本例如：`scripts/summarize-issues.mjs`，输入 `gh issue list` 结果，输出结构化 JSON。

建议输出结构：

```json
{
  "high_priority": [
    { "id": 123, "title": "...", "reason": "..." }
  ],
  "quick_wins": [
    { "id": 456, "title": "...", "reason": "..." }
  ],
  "duplicates": [
    { "source": 10, "target": 8, "reason": "..." }
  ]
}
```

建议最小工作流：

1. 用 `gh issue list --limit N --json number,title,labels,updatedAt,body` 拉取 issue
2. 调用 Provider 生成 JSON 摘要
3. 校验 JSON 结构
4. 生成 markdown 报告（例如输出到 `docs/todo/issues-summary.md`）
5. AI 失败时退化为规则排序（按标签/更新时间）

## 7. 本地调试命令示例

Release 摘要脚本本地测试：

```powershell
$env:APP_NAME="Sutu"
$env:RELEASE_TAG="v0.10.3"
$env:RELEASE_VERSION="0.10.3"
$env:GITHUB_REPOSITORY="LiuYangArt/PaintBoard"
$env:RELEASE_NOTES_API_KEY="<your-key>"
$env:RELEASE_NOTES_MODEL="gemini-3-flash-preview"
$env:RELEASE_NOTES_API_BASE_URL="https://yunwu.ai"
$env:RELEASE_NOTES_API_PATH="/v1/chat/completions"
$env:RELEASE_BODY_PATH="__tmp_release_body.md"
node scripts/generate-release-notes.mjs
```

## 8. 安全建议

- API Key 只放 Secret，不要写进仓库文件。
- Key 一旦泄露，立刻在 Provider 后台旋转。
- 避免在 issue/release 文案中输出原始敏感信息。
