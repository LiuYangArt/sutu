#!/usr/bin/env node
/**
 * 生成 GitHub Release 正文：
 * 1) 有 API Key 时，用 AI 基于本次提交生成中英双语变更摘要
 * 2) 自动过滤 thinking / reasoning 内容，避免进入最终 Release 文案
 * 3) 没有密钥或调用失败时，回退到基于 commit 的双语摘要
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

function normalizeBullet(text) {
  return String(text || '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isThinkingBullet(text) {
  const value = text.trim();
  return /^(thinking|analysis|reasoning|thoughts?|chain[- ]of[- ]thought|思考|推理|分析)/i.test(value);
}

function toBulletList(values, maxSize = 8) {
  const unique = [];
  for (const item of values) {
    const normalized = normalizeBullet(item);
    if (!normalized || isThinkingBullet(normalized)) {
      continue;
    }
    if (!unique.includes(normalized)) {
      unique.push(normalized);
    }
  }

  if (unique.length <= maxSize) {
    return unique;
  }
  return unique.slice(0, maxSize);
}

function parseBilingualItems(rawText) {
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

  const zhSource = parsed?.zh ?? parsed?.zh_cn ?? parsed?.cn ?? parsed?.chinese ?? [];
  const enSource = parsed?.en ?? parsed?.en_us ?? parsed?.english ?? [];

  const zhItems = toBulletList(Array.isArray(zhSource) ? zhSource : []);
  const enItems = toBulletList(Array.isArray(enSource) ? enSource : []);

  if (zhItems.length === 0 || enItems.length === 0) {
    return null;
  }

  return {
    zhItems,
    enItems,
  };
}

function buildBilingualChangesSection(zhItems, enItems, compareUrl) {
  const lines = ['### Changes / 更新', '#### 中文'];
  for (const item of zhItems) {
    lines.push(`- ${item}`);
  }
  if (compareUrl) {
    lines.push(`- 完整对比：${compareUrl}`);
  }

  lines.push('');
  lines.push('#### English');
  for (const item of enItems) {
    lines.push(`- ${item}`);
  }
  if (compareUrl) {
    lines.push(`- Full compare: ${compareUrl}`);
  }

  return lines.join('\n').trim();
}

async function generateAiChanges({
  appName,
  version,
  currentTag,
  previousTag,
  commits,
  aiApiKey,
  aiModel,
  aiApiBaseUrl,
  aiApiPath,
  compareUrl,
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
    compareUrl ? `Compare: ${compareUrl}` : 'Compare: (unavailable)',
    '',
    'Commits in this release:',
    commitBlock,
    '',
    '请基于以上信息输出版本变更摘要，必须严格遵守：',
    '1) 仅返回一个 JSON 对象，不要 markdown，不要代码块，不要额外解释。',
    '2) JSON 结构必须是：{"zh":["..."],"en":["..."]}',
    '3) zh 与 en 都要有 4-8 条，聚焦用户可感知变化。',
    '4) 禁止输出 thinking、analysis、reasoning、思考过程等内容。',
    '5) 如果存在潜在破坏性变更，需在 zh 与 en 都明确标注。',
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
          content: '你是发布工程师。输出必须可直接用于 Release Notes，不得包含推理过程。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
      temperature: 0.2,
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

  const parsed = parseBilingualItems(generatedText);
  if (!parsed) {
    throw new Error('AI 返回格式不符合预期（缺少可解析的 zh/en JSON）');
  }

  return buildBilingualChangesSection(parsed.zhItems, parsed.enItems, compareUrl);
}

function generateFallbackChanges(commits, compareUrl) {
  const zhItems = [];
  const enItems = [];

  if (commits.length === 0) {
    zhItems.push('本次未检测到可归纳的提交记录，可能仅包含发布流程调整或重新打包。');
    enItems.push('No notable commits were detected; this release may contain packaging or release-process updates only.');
  } else {
    const topCommits = commits.slice(0, 8);
    for (const commit of topCommits) {
      zhItems.push(`提交：${commit.subject} (${commit.hash})`);
      enItems.push(`Commit: ${commit.subject} (${commit.hash})`);
    }
    if (commits.length > topCommits.length) {
      const extra = commits.length - topCommits.length;
      zhItems.push(`其余 ${extra} 项改动请查看提交历史。`);
      enItems.push(`See commit history for the remaining ${extra} changes.`);
    }
  }

  return buildBilingualChangesSection(zhItems, enItems, compareUrl);
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

  let changesSection = '';
  if (aiApiKey) {
    try {
      changesSection = await generateAiChanges({
        appName,
        version,
        currentTag,
        previousTag,
        commits,
        aiApiKey,
        aiModel,
        aiApiBaseUrl,
        aiApiPath,
        compareUrl,
      });
      log(`AI 生成成功（model=${aiModel}）。`);
    } catch (error) {
      log(`AI 生成失败，使用回退摘要。原因: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    log('未检测到 RELEASE_NOTES_API_KEY（或 OPENAI_API_KEY），使用回退摘要。');
  }

  if (!changesSection) {
    changesSection = generateFallbackChanges(commits, compareUrl);
  }

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
