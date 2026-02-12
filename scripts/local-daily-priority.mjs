#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { callJsonWithAi, hasAiProvider, resolveAiProviderConfig } from './lib/ai-provider-client.mjs';
import { parseTodoMarkdown, SECTION_KEYS } from './lib/todo-parser.mjs';

const TODO_FILE_PATH = process.env.ISSUE_TODO_FILE_PATH || 'docs/todo/issues.md';
const TOP_LIMIT = Number.parseInt(process.env.TODAY_TOP_LIMIT || '3', 10);
const SECONDARY_LIMIT = Number.parseInt(process.env.TODAY_SECONDARY_LIMIT || '5', 10);

function log(message) {
  process.stdout.write(`[task-today] ${message}\n`);
}

function runCommand(bin, args, { allowFailure = false } = {}) {
  const result = spawnSync(bin, args, {
    env: process.env,
    encoding: 'utf-8',
  });
  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${bin} ${args.join(' ')} failed (${result.status}): ${stderr || stdout}`);
  }
  return { status: result.status ?? 1, stdout, stderr };
}

async function runGh(args, options = {}) {
  const retries = Number.parseInt(process.env.GH_RETRY_COUNT || '2', 10);
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return runCommand('gh', args, options);
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep((attempt + 1) * 1000);
      }
    }
  }
  throw lastError;
}

async function fetchRepoInfo() {
  const { stdout } = await runGh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']);
  return JSON.parse(stdout || '{}');
}

function encodeRepoPath(path) {
  return String(path || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseIssueType(issue) {
  const labelNames = Array.isArray(issue.labels) ? issue.labels.map((item) => item.name) : [];
  if (labelNames.includes('bug')) {
    return 'bug';
  }
  if (labelNames.includes('enhancement')) {
    return 'enhancement';
  }

  const title = normalizeText(issue.title).toLowerCase();
  const body = normalizeText(issue.body).toLowerCase();
  if (/\[feature\]/i.test(title)) {
    return 'enhancement';
  }
  if (/\[bug\]/i.test(title)) {
    return 'bug';
  }
  if (/\[bug\]|问题描述|复现步骤|实际结果|crash|bug|崩溃|卡死|无法启动|data loss/i.test(`${title}\n${body}`)) {
    return 'bug';
  }
  return 'enhancement';
}

function inferSectionFromIssue(issue) {
  const combined = `${normalizeText(issue.title)}\n${normalizeText(issue.body)}`;
  const issueType = parseIssueType(issue);
  if (/阻塞主进程|主线程阻塞|crash|崩溃|卡死|freeze|hang|无法启动|数据丢失|data loss|无法绘制/i.test(combined)) {
    return 'p0';
  }
  if (issueType === 'bug') {
    return 'p1';
  }
  if (/优化|polish|idea|长期|future|backlog/.test(combined)) {
    return 'p3';
  }
  return 'p2';
}

async function fallbackFromOpenIssues() {
  const { stdout } = await runGh([
    'issue',
    'list',
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,title,body,labels,url,updatedAt,createdAt',
  ]);
  const issues = JSON.parse(stdout || '[]').sort((left, right) => {
    const lt = new Date(left.updatedAt || left.createdAt || 0).getTime();
    const rt = new Date(right.updatedAt || right.createdAt || 0).getTime();
    return rt - lt;
  });
  const sections = { p0: [], p1: [], p2: [], p3: [] };
  for (const issue of issues) {
    const section = inferSectionFromIssue(issue);
    const labels = Array.isArray(issue.labels) ? issue.labels.map((item) => item.name).filter(Boolean) : [];
    sections[section].push({
      number: issue.number,
      title: issue.title,
      labels,
      reason: '基于当前 open issues 自动排序（可直接用于今日排期）。',
      url: issue.url,
    });
  }
  return sections;
}

async function fetchTodoFromGitHub(nameWithOwner, branch, filePath) {
  const endpoint = `repos/${nameWithOwner}/contents/${encodeRepoPath(filePath)}?ref=${encodeURIComponent(branch)}`;
  const { stdout } = await runGh(['api', endpoint]);
  const payload = JSON.parse(stdout || '{}');
  const content = String(payload.content || '').replace(/\n/g, '');
  if (!content) {
    throw new Error(`No file content from ${filePath}`);
  }
  return Buffer.from(content, 'base64').toString('utf-8');
}

async function rankWithAi(aiConfig, sectionKey, items) {
  if (!hasAiProvider(aiConfig) || items.length < 2) {
    return items;
  }

  const systemPrompt = [
    'You are a strict engineering task ranker.',
    'Return JSON only.',
    'No markdown and no chain-of-thought.',
  ].join(' ');

  const userPrompt = [
    `Rank tasks within section ${sectionKey}.`,
    'Output JSON schema:',
    '{"ordered_numbers":[number,...],"reasons":{"<issue_number>":"one short reason"}}',
    'Rules:',
    '1) Keep same section only; do not introduce new issue numbers.',
    '2) Prioritize impact, risk and dependency.',
    '3) Reasons must be concise.',
    '',
    ...items.map((item, index) => `${index + 1}. #${item.number} ${item.title} | ${item.reason}`),
  ].join('\n');

  const ranked = await callJsonWithAi({
    config: aiConfig,
    systemPrompt,
    userPrompt,
    operationName: `daily-rank-${sectionKey}`,
    guard: (payload) =>
      Array.isArray(payload?.ordered_numbers) && payload.ordered_numbers.every((item) => Number.isFinite(item)),
  });

  const itemMap = new Map(items.map((item) => [item.number, item]));
  const ordered = [];
  for (const issueNumber of ranked.ordered_numbers) {
    if (!itemMap.has(issueNumber)) {
      continue;
    }
    const source = itemMap.get(issueNumber);
    const aiReason = ranked?.reasons?.[String(issueNumber)];
    ordered.push({
      ...source,
      reason: typeof aiReason === 'string' && aiReason.trim() ? aiReason.trim() : source.reason,
    });
    itemMap.delete(issueNumber);
  }

  for (const remaining of itemMap.values()) {
    ordered.push(remaining);
  }
  return ordered;
}

function flattenByPriority(sections) {
  const result = [];
  for (const key of SECTION_KEYS) {
    const bucket = sections[key] || [];
    for (const item of bucket) {
      result.push({ ...item, section: key });
    }
  }
  return result;
}

function sectionToPriorityLabel(section) {
  return `priority:${section}`;
}

function printTaskList(title, tasks) {
  process.stdout.write(`\n${title}\n`);
  if (tasks.length === 0) {
    process.stdout.write('- (none)\n');
    return;
  }
  for (const task of tasks) {
    process.stdout.write(
      `- #${task.number} [${sectionToPriorityLabel(task.section)}] ${task.title}\n  reason: ${task.reason}\n  url: ${task.url}\n`,
    );
  }
}

async function main() {
  const repoInfo = await fetchRepoInfo();
  const nameWithOwner = repoInfo?.nameWithOwner;
  const branch = repoInfo?.defaultBranchRef?.name || 'master';
  if (!nameWithOwner) {
    throw new Error('Unable to resolve repository from gh.');
  }

  const markdown = await fetchTodoFromGitHub(nameWithOwner, branch, TODO_FILE_PATH);
  const parsed = parseTodoMarkdown(markdown);
  const aiConfig = resolveAiProviderConfig(process.env);
  const parsedTaskCount = SECTION_KEYS.reduce((acc, key) => acc + (parsed.sections[key] || []).length, 0);
  const sourceSections = parsedTaskCount > 0 ? parsed.sections : await fallbackFromOpenIssues();
  if (parsedTaskCount === 0) {
    log('GitHub 上的 docs/todo/issues.md 还没切到新模板，已直接按 open issues 生成优先级。');
  }

  const rankedSections = { p0: [], p1: [], p2: [], p3: [] };
  for (const key of SECTION_KEYS) {
    const items = sourceSections[key] || [];
    try {
      rankedSections[key] = await rankWithAi(aiConfig, key, items);
    } catch (error) {
      rankedSections[key] = items;
      log(`AI ranking skipped for ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const orderedTasks = flattenByPriority(rankedSections);
  const topTasks = orderedTasks.slice(0, TOP_LIMIT);
  const secondary = orderedTasks.slice(TOP_LIMIT, TOP_LIMIT + SECONDARY_LIMIT);
  const deferred = rankedSections.p3.slice(0, SECONDARY_LIMIT).map((item) => ({ ...item, section: 'p3' }));

  process.stdout.write(`# 今日工作建议\n`);
  process.stdout.write(`- Source: ${nameWithOwner}/${TODO_FILE_PATH}@${branch}\n`);
  process.stdout.write(`- Generated at (UTC): ${new Date().toISOString()}\n`);

  printTaskList('## 今日 Top 3（必须做）', topTasks);
  printTaskList('## 次优先级候选（有余力再做）', secondary);
  printTaskList('## 建议延后项', deferred);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[task-today] fatal: ${message}\n`);
  process.exit(1);
});
