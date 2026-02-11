#!/usr/bin/env node
/**
 * 生成 GitHub Release 正文：
 * 1) 有 OPENAI_API_KEY 时，用 AI 基于本次提交生成变更摘要
 * 2) 没有密钥或调用失败时，回退到基于 commit 的规则摘要
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

function extractTextFromResponse(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const chunks = [];
  const output = Array.isArray(payload?.output) ? payload.output : [];
  for (const item of output) {
    const contentItems = Array.isArray(item?.content) ? item.content : [];
    for (const content of contentItems) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content?.text === 'string') {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function removeMarkdownFence(text) {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function ensureChangesSection(text, compareUrl) {
  const cleaned = removeMarkdownFence(text);
  let normalized = cleaned;
  if (!/^###\s+Changes/m.test(cleaned)) {
    const lines = cleaned
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (line.startsWith('- ') ? line : `- ${line}`));
    normalized = ['### Changes', ...lines].join('\n');
  }

  if (compareUrl && !normalized.includes(compareUrl)) {
    normalized = `${normalized}\n- Full compare: ${compareUrl}`;
  }
  return normalized.trim();
}

async function generateAiChanges({ appName, version, currentTag, previousTag, commits, openAiApiKey, openAiModel, compareUrl }) {
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
    '请基于以上信息输出 GitHub Release 的“变更摘要”部分，要求：',
    '1. 输出必须是 Markdown。',
    '2. 第一行固定为 `### Changes`。',
    '3. 只输出 4-8 条关键 bullet，面向用户价值，避免流水账。',
    '4. 用简体中文，语气客观。',
    '5. 如果有潜在破坏性变更，要明确标出。',
    '6. 不要输出安装说明、requirements、致谢等其他章节。',
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openAiModel,
      input: [
        {
          role: 'system',
          content: '你是一个发布工程师，擅长将 commit 历史提炼成准确、简洁、可读的版本更新日志。',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      max_output_tokens: 600,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const payload = await response.json();
  const generatedText = extractTextFromResponse(payload);
  if (!generatedText) {
    throw new Error('OpenAI 返回为空');
  }

  return ensureChangesSection(generatedText, compareUrl);
}

function generateFallbackChanges(commits, compareUrl) {
  const lines = ['### Changes'];

  if (commits.length === 0) {
    lines.push('- 本次版本未检测到可归纳的提交记录，可能是仅调整发布流程或重新打包。');
  } else {
    const topCommits = commits.slice(0, 12);
    for (const commit of topCommits) {
      lines.push(`- ${commit.subject} (${commit.hash})`);
    }
    if (commits.length > topCommits.length) {
      lines.push(`- 其余 ${commits.length - topCommits.length} 项改动请查看提交历史。`);
    }
  }

  if (compareUrl) {
    lines.push(`- Full compare: ${compareUrl}`);
  }

  return lines.join('\n');
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

  const openAiApiKey = (process.env.OPENAI_API_KEY || '').trim();
  const openAiModel = (process.env.OPENAI_MODEL || 'gpt-4.1-mini').trim();

  let changesSection = '';
  if (openAiApiKey) {
    try {
      changesSection = await generateAiChanges({
        appName,
        version,
        currentTag,
        previousTag,
        commits,
        openAiApiKey,
        openAiModel,
        compareUrl,
      });
      log(`AI 生成成功（model=${openAiModel}）。`);
    } catch (error) {
      log(`AI 生成失败，使用回退摘要。原因: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    log('未检测到 OPENAI_API_KEY，使用回退摘要。');
  }

  if (!changesSection) {
    changesSection = generateFallbackChanges(commits, compareUrl);
  }

  const body = [
    `## ${appName} v${version}`,
    '',
    changesSection,
    '',
    '### Installation',
    '- **Windows**: Download `.msi` or `.exe` installer; or `.zip` for portable mode',
    '- **macOS**: Download `.dmg` package (and updater archive/signature if needed)',
    '',
    '### Requirements',
    '- Windows 10 (1903) or later',
    '- WebView2 Runtime (included in Windows 11, auto-installed on Windows 10)',
    '- macOS 11 or later (actual minimum follows your app/SDK config)',
    '',
  ].join('\n');

  writeFileSync(outputPath, body, 'utf-8');
  log(`已写入 Release 正文: ${outputPath}`);
}

main().catch((error) => {
  process.stderr.write(`[release-notes] ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
