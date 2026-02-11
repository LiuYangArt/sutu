#!/usr/bin/env node
/**
 * 生成 GitHub Release 正文：
 * 1) 有 API Key 时，用 AI 生成“功能更新 + 问题修复”双语摘要
 * 2) 自动过滤 thinking/reasoning 内容，禁止进入最终 Release 文案
 * 3) 没有密钥或 AI 输出不合规时，回退到本地规则化双语精简摘要
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function log(message) {
  process.stdout.write(`[release-notes] ${message}\n`);
}

function run(command) {
  return execSync(command, { encoding: 'utf-8' }).trim();
}

function safeRun(command) {
  try {
    return run(command);
  } catch {
    return '';
  }
}

function normalizeTag(rawTag) {
  return rawTag.trim();
}

function resolveCurrentTag() {
  const fromEnv = normalizeTag(process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || '');
  if (fromEnv) {
    return fromEnv;
  }
  return normalizeTag(safeRun('git describe --tags --exact-match HEAD'));
}

function resolvePreviousTag(currentTag) {
  const raw = safeRun('git tag --sort=-creatordate');
  if (!raw) {
    return '';
  }

  const tags = raw
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => /^v\d+\.\d+\.\d+/.test(item));

  const currentIndex = tags.indexOf(currentTag);
  if (currentIndex >= 0 && currentIndex + 1 < tags.length) {
    return tags[currentIndex + 1];
  }

  return '';
}

function collectCommits(previousTag, currentTag) {
  const range = previousTag ? `${previousTag}..${currentTag}` : currentTag;
  const raw = safeRun(`git log ${range} --pretty=format:%h%x09%s%x09%an --no-merges`);
  if (!raw) {
    return [];
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author] = line.split('\t');
      return {
        hash: (hash || '').trim(),
        subject: (subject || '').trim(),
        author: (author || '').trim(),
      };
    })
    .filter((item) => item.subject.length > 0);
}

function joinUrl(baseUrl, path) {
  const base = (baseUrl || '').trim().replace(/\/+$/, '');
  const suffix = (path || '').trim();
  if (!base) {
    throw new Error('AI API base URL 不能为空');
  }
  if (!suffix) {
    throw new Error('AI API path 不能为空');
  }
  if (/^https?:\/\//i.test(suffix)) {
    return suffix;
  }
  return `${base}/${suffix.replace(/^\/+/, '')}`;
}

function extractTextFromChatCompletions(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item?.type === 'text' && typeof item?.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('\n')
      .trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function stripThinkingArtifacts(text) {
  if (!text) {
    return '';
  }

  let output = text.replace(/\r\n/g, '\n');
  output = output.replace(/<think>[\s\S]*?<\/think>/gi, '');
  output = output.replace(/```(?:thinking|analysis|reasoning)[\s\S]*?```/gi, '');

  const headingBlockRegex = /^\s{0,3}#{1,6}\s*(thinking|analysis|reasoning|thoughts?|chain[- ]of[- ]thought|思考|推理|分析过程|思维链)\b/i;
  const inlineThinkingRegex =
    /^\s*(thinking|analysis|reasoning|chain[- ]of[- ]thought|thoughts?|思考过程|推理过程|分析过程)\s*[:：]/i;
  const headingRegex = /^\s{0,3}#{1,6}\s+\S/;

  const lines = output.split('\n');
  const filtered = [];
  let skippingThinkingBlock = false;

  for (const line of lines) {
    if (headingBlockRegex.test(line)) {
      skippingThinkingBlock = true;
      continue;
    }
    if (skippingThinkingBlock) {
      if (headingRegex.test(line)) {
        skippingThinkingBlock = false;
      } else {
        continue;
      }
    }
    if (inlineThinkingRegex.test(line.trim())) {
      continue;
    }
    filtered.push(line);
  }

  return filtered.join('\n').trim();
}

function extractFirstJsonObject(text) {
  const source = text || '';
  const start = source.indexOf('{');
  if (start < 0) {
    return '';
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return '';
}

function normalizeSentence(text) {
  return String(text || '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cjkCount(text) {
  const matches = String(text || '').match(/[\u3400-\u9fff]/g);
  return matches ? matches.length : 0;
}

function normalizePairItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const zh = normalizeSentence(item.zh);
  const en = normalizeSentence(item.en);
  if (!zh || !en) {
    return null;
  }
  if (cjkCount(en) > 0) {
    return null;
  }
  return { zh, en };
}

function dedupePairs(items) {
  const result = [];
  const seen = new Set();

  for (const item of items) {
    const normalized = normalizePairItem(item);
    if (!normalized) {
      continue;
    }
    const key = `${normalized.zh}__${normalized.en}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function clampPairs(items, maxCount = 3) {
  return dedupePairs(items).slice(0, maxCount);
}

function parseAiSummary(rawText) {
  const cleaned = stripThinkingArtifacts(rawText);
  if (!cleaned) {
    return null;
  }

  const objectText = extractFirstJsonObject(cleaned);
  if (!objectText) {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(objectText);
  } catch {
    return null;
  }

  const featuresSource = Array.isArray(parsed?.features) ? parsed.features : [];
  const fixesSource = Array.isArray(parsed?.fixes) ? parsed.fixes : [];

  const features = clampPairs(featuresSource, 3);
  const fixes = clampPairs(fixesSource, 3);

  if (features.length === 0 && fixes.length === 0) {
    return null;
  }

  return { features, fixes };
}

function buildChangesSection(summary, compareUrl) {
  const features = Array.isArray(summary?.features) ? summary.features : [];
  const fixes = Array.isArray(summary?.fixes) ? summary.fixes : [];

  const lines = ['### Changes / 更新', '#### 功能更新 / Features'];

  if (features.length === 0) {
    lines.push('- 中文：本版本无新增用户可见功能。');
    lines.push('- English: No new user-facing features in this release.');
  } else {
    for (const item of features) {
      lines.push(`- 中文：${item.zh}`);
      lines.push(`- English: ${item.en}`);
    }
  }

  lines.push('');
  lines.push('#### 问题修复 / Bug Fixes');

  if (fixes.length === 0) {
    lines.push('- 中文：本版本无新增用户可见问题修复。');
    lines.push('- English: No new user-facing bug fixes in this release.');
  } else {
    for (const item of fixes) {
      lines.push(`- 中文：${item.zh}`);
      lines.push(`- English: ${item.en}`);
    }
  }

  if (compareUrl) {
    lines.push('');
    lines.push(`- 中文：完整对比：${compareUrl}`);
    lines.push(`- English: Full compare: ${compareUrl}`);
  }

  return lines.join('\n').trim();
}

const IGNORE_PATTERNS = [
  /^v?\d+\.\d+\.\d+$/i,
  /(^|\s)(release|chore|ci|workflow|pipeline|lint|format|deps?)(\s|:|$)/i,
  /发布流程|发包|打包|自动发布|workflow|readme|文档|docs?|license|图标|icon|logo/i,
];

const FIX_PATTERNS = [/修复|fix|bug|crash|异常|错误|闪退|崩溃|失效|问题/i];

const FEATURE_PATTERNS = [/新增|增加|支持|加入|实现|introduce|add|support|implement|feature|新功能|工具/i];

const TOPIC_RULES = [
  {
    id: 'brush-settings-fix',
    type: 'fix',
    pattern: /opacity|flow|笔刷|画笔|brush/i,
    zh: '修复了笔刷参数设置相关问题（含 opacity/flow 设置边界）。',
    en: 'Fixed brush parameter setting issues, including opacity/flow boundary handling.',
  },
  {
    id: 'export-fix',
    type: 'fix',
    pattern: /导出|export|保存|save|读取|load|文件/i,
    zh: '修复了文件导出与保存链路中的稳定性问题。',
    en: 'Fixed stability issues in export and save workflows.',
  },
  {
    id: 'layer-fix',
    type: 'fix',
    pattern: /图层|layer/i,
    zh: '修复了图层相关交互中的异常行为。',
    en: 'Fixed abnormal behaviors in layer-related interactions.',
  },
  {
    id: 'input-fix',
    type: 'fix',
    pattern: /快捷键|shortcut|hotkey|键盘|输入|压感|wacom|tablet/i,
    zh: '修复了输入与快捷键相关的问题。',
    en: 'Fixed input and shortcut-related issues.',
  },
  {
    id: 'feature-tooling',
    type: 'feature',
    pattern: /工具|tool|面板|panel|交互|ui|界面/i,
    zh: '改进了绘画工具与界面交互体验。',
    en: 'Improved drawing tools and UI interaction experience.',
  },
  {
    id: 'feature-performance',
    type: 'feature',
    pattern: /性能|优化|卡顿|流畅|latency|performance|speed/i,
    zh: '优化了绘制链路性能，提升整体响应速度。',
    en: 'Optimized drawing pipeline performance for better responsiveness.',
  },
];

function shouldIgnoreCommit(subject) {
  return IGNORE_PATTERNS.some((pattern) => pattern.test(subject));
}

function isFixCommit(subject) {
  return FIX_PATTERNS.some((pattern) => pattern.test(subject));
}

function isFeatureCommit(subject) {
  return FEATURE_PATTERNS.some((pattern) => pattern.test(subject));
}

function summarizeFallback(commits) {
  const features = [];
  const fixes = [];
  const seenRuleIds = new Set();

  function pushFeature(zh, en) {
    if (features.length >= 3) {
      return;
    }
    const key = `${zh}__${en}`;
    if (features.some((item) => `${item.zh}__${item.en}` === key)) {
      return;
    }
    features.push({ zh, en });
  }

  function pushFix(zh, en) {
    if (fixes.length >= 3) {
      return;
    }
    const key = `${zh}__${en}`;
    if (fixes.some((item) => `${item.zh}__${item.en}` === key)) {
      return;
    }
    fixes.push({ zh, en });
  }

  for (const commit of commits) {
    const subject = normalizeSentence(commit.subject);
    if (!subject || shouldIgnoreCommit(subject)) {
      continue;
    }

    let matchedTopic = false;
    for (const rule of TOPIC_RULES) {
      if (!rule.pattern.test(subject)) {
        continue;
      }
      if (seenRuleIds.has(rule.id)) {
        matchedTopic = true;
        break;
      }
      seenRuleIds.add(rule.id);
      if (rule.type === 'fix') {
        pushFix(rule.zh, rule.en);
      } else {
        pushFeature(rule.zh, rule.en);
      }
      matchedTopic = true;
      break;
    }
    if (matchedTopic) {
      continue;
    }

    if (isFixCommit(subject)) {
      pushFix('修复了若干影响使用体验的问题。', 'Fixed several issues affecting user experience.');
      continue;
    }

    if (isFeatureCommit(subject)) {
      pushFeature('新增或改进了部分用户可见功能。', 'Added or improved several user-facing features.');
    }
  }

  return { features, fixes };
}

async function generateAiSummary({
  appName,
  version,
  currentTag,
  previousTag,
  commits,
  aiApiKey,
  aiModel,
  aiApiBaseUrl,
  aiApiPath,
}) {
  const commitBlock = commits.length
    ? commits
        .slice(0, 120)
        .map((item, index) => `${index + 1}. ${item.subject} [${item.hash}] (${item.author})`)
        .join('\n')
    : '(no commits found)';

  const prompt = [
    `App: ${appName}`,
    `Version: ${version}`,
    `Current tag: ${currentTag}`,
    `Previous tag: ${previousTag || '(none)'}`,
    '',
    'Commits in this release:',
    commitBlock,
    '',
    '请输出用于 Release Notes 的精简摘要，严格遵守：',
    '1) 只保留用户真正需要关心的信息：功能更新（features）和问题修复（fixes）。',
    '2) 忽略内部改动：发布流程、CI、文档、图标、重构、纯维护。',
    '3) 将同一主题的多个 commit 合并成一条，避免重复和冗余。',
    '4) 每类最多 3 条，句子简洁、面向用户价值。',
    '5) 只返回一个 JSON 对象，不要 markdown，不要代码块，不要解释，不要 thinking/reasoning。',
    '6) JSON 结构必须是：',
    '{"features":[{"zh":"...","en":"..."}],"fixes":[{"zh":"...","en":"..."}]}',
    '7) en 字段必须是英文，不能包含中文字符。',
  ].join('\n');

  const endpoint = joinUrl(aiApiBaseUrl, aiApiPath);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${aiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: aiModel,
      messages: [
        {
          role: 'system',
          content: '你是发布工程师。输出仅允许最终可发布内容，严禁输出任何推理过程。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI API ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const payload = await response.json();
  const generatedText = extractTextFromChatCompletions(payload);
  if (!generatedText) {
    throw new Error('AI 返回为空');
  }

  const parsed = parseAiSummary(generatedText);
  if (!parsed) {
    throw new Error('AI 返回格式不符合要求（需要 features/fixes 双语 JSON）');
  }

  return parsed;
}

async function main() {
  const appName = (process.env.APP_NAME || 'PaintBoard').trim();
  const currentTag = resolveCurrentTag();
  if (!currentTag) {
    throw new Error('无法确定当前发布 tag，请设置 RELEASE_TAG 或 GITHUB_REF_NAME。');
  }

  const version = (process.env.RELEASE_VERSION || currentTag.replace(/^v/, '')).trim();
  const outputPath = process.env.RELEASE_BODY_PATH || join(process.cwd(), 'release-body.md');
  const previousTag = resolvePreviousTag(currentTag);
  const commits = collectCommits(previousTag, currentTag);
  const repo = (process.env.GITHUB_REPOSITORY || '').trim();
  const compareUrl = previousTag && repo ? `https://github.com/${repo}/compare/${previousTag}...${currentTag}` : '';

  const aiApiKey = (process.env.RELEASE_NOTES_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const aiModel = (process.env.RELEASE_NOTES_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();
  const aiApiBaseUrl = (process.env.RELEASE_NOTES_API_BASE_URL || process.env.OPENAI_API_BASE_URL || 'https://api.openai.com').trim();
  const aiApiPath = (process.env.RELEASE_NOTES_API_PATH || process.env.OPENAI_API_PATH || '/v1/chat/completions').trim();

  let summary = null;
  if (aiApiKey) {
    try {
      summary = await generateAiSummary({
        appName,
        version,
        currentTag,
        previousTag,
        commits,
        aiApiKey,
        aiModel,
        aiApiBaseUrl,
        aiApiPath,
      });
      log(`AI 生成成功（model=${aiModel}）。`);
    } catch (error) {
      log(`AI 生成失败，使用回退摘要。原因: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    log('未检测到 RELEASE_NOTES_API_KEY（或 OPENAI_API_KEY），使用回退摘要。');
  }

  if (!summary) {
    summary = summarizeFallback(commits);
  }

  const changesSection = buildChangesSection(summary, compareUrl);

  const body = [
    `## ${appName} v${version}`,
    '',
    changesSection,
    '',
    '### Installation / 安装',
    '- 中文：Windows 下载 `.msi` 或 `.exe` 安装包；便携模式使用 `.zip`。',
    '- English: On Windows, download the `.msi` or `.exe` installer; use `.zip` for portable mode.',
    '- 中文：macOS 下载 `.dmg` 安装包（如需自动更新，可同时下载 app 压缩包与签名文件）。',
    '- English: On macOS, download the `.dmg` package (optionally download app archive/signature for updater flows).',
    '',
    '### Requirements / 系统要求',
    '- 中文：Windows 10（1903）或更高版本。',
    '- English: Windows 10 (1903) or later.',
    '- 中文：需要 WebView2 Runtime（Windows 11 内置，Windows 10 会自动安装）。',
    '- English: WebView2 Runtime is required (built into Windows 11 and auto-installed on Windows 10).',
    '- 中文：macOS 11 或更高版本（实际最低版本以应用/SDK 配置为准）。',
    '- English: macOS 11 or later (actual minimum follows app/SDK configuration).',
    '',
  ].join('\n');

  writeFileSync(outputPath, body, 'utf-8');
  log(`已写入 Release 正文: ${outputPath}`);
}

main().catch((error) => {
  process.stderr.write(`[release-notes] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
