#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callJsonWithAi, hasAiProvider, resolveAiProviderConfig } from './lib/ai-provider-client.mjs';
import { renderTodoMarkdown } from './lib/todo-parser.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SCRIPT_DIR);
const TODO_FILE_PATH = process.env.ISSUE_TODO_FILE_PATH || 'docs/todo/issues.md';
const LOOKBACK_HOURS = Number.parseInt(process.env.ISSUE_LOOKBACK_HOURS || '8', 10);
const DUPLICATE_CONFIDENCE = Number.parseFloat(process.env.ISSUE_DUPLICATE_CONFIDENCE || '0.92');
const DUPLICATE_SIMILARITY = Number.parseFloat(process.env.ISSUE_DUPLICATE_SIMILARITY || '0.78');
const TRIAGE_MODE = (process.env.ISSUE_TRIAGE_MODE || 'incremental').trim().toLowerCase();
const DRY_RUN_CLOSE = /^(1|true|yes)$/i.test(process.env.ISSUE_TRIAGE_DRY_RUN_CLOSE || 'true');
const SKIP_GIT_WRITE = /^(1|true|yes)$/i.test(process.env.ISSUE_TRIAGE_SKIP_GIT || 'false');
const READ_ONLY = /^(1|true|yes)$/i.test(process.env.ISSUE_TRIAGE_READONLY || 'false');

const PRIORITY_LABELS = ['priority:p0', 'priority:p1', 'priority:p2', 'priority:p3'];
const TYPE_LABELS = ['bug', 'enhancement'];
const TRIAGE_LABEL = 'triage:needs-ai-retry';
const DUPLICATE_CANDIDATE_LABEL = 'duplicate-candidate';

const REQUIRED_LABELS = [
  { name: 'priority:p0', color: 'B60205', description: 'Blocking issue, highest priority.' },
  { name: 'priority:p1', color: 'D93F0B', description: 'Important bug to be handled soon.' },
  { name: 'priority:p2', color: 'FBCA04', description: 'Default feature/bug priority.' },
  { name: 'priority:p3', color: '0E8A16', description: 'Backlog and low urgency.' },
  { name: TRIAGE_LABEL, color: '5319E7', description: 'Needs AI retry in recovery workflow.' },
  { name: DUPLICATE_CANDIDATE_LABEL, color: 'C5DEF5', description: 'Potential duplicate; not auto-closed.' },
];

function log(message) {
  process.stdout.write(`[issue-triage] ${message}\n`);
}

function runCommand(bin, args, { allowFailure = false, cwd = PROJECT_ROOT } = {}) {
  const result = spawnSync(bin, args, {
    cwd,
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

function runGh(args, options = {}) {
  return runCommand('gh', args, options);
}

function runGit(args, options = {}) {
  return runCommand('git', args, options);
}

function readJsonFromGh(args) {
  const { stdout } = runGh(args);
  return JSON.parse(stdout || 'null');
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function bodySnippet(body, maxLength = 900) {
  return normalizeText(body).slice(0, maxLength);
}

function getIssueLabelNames(issue) {
  return Array.isArray(issue.labels) ? issue.labels.map((item) => item.name).filter(Boolean) : [];
}

function parseIssueType(issue) {
  const labels = getIssueLabelNames(issue);
  if (labels.includes('bug')) {
    return 'bug';
  }
  if (labels.includes('enhancement')) {
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

  const bugPattern =
    /\[bug\]|问题描述|复现步骤|实际结果|crash|bug|异常|错误|崩溃|闪退|卡死|无法启动|无法绘制|data loss|freeze/i;
  const featurePattern = /\[feature\]|需求背景|建议方案|预期收益|feature request|功能建议|改进建议/i;

  if (bugPattern.test(title) || bugPattern.test(body)) {
    return 'bug';
  }
  if (featurePattern.test(title) || featurePattern.test(body)) {
    return 'enhancement';
  }

  return 'enhancement';
}

function computePriority(issue, issueType) {
  const title = normalizeText(issue.title);
  const body = normalizeText(issue.body);
  const combined = `${title}\n${body}`;

  const p0Pattern =
    /阻塞主进程|主线程阻塞|crash|崩溃|闪退|卡死|freeze|hang|无法启动|cannot start|data loss|数据丢失|无法绘制|cannot draw/i;
  const p1Pattern = /回归|regression|关键|核心|高频|严重|major|不一致|incorrect|功能失效|无法正常/i;
  const p3Pattern = /优化|polish|idea|想法|长期|future|后续|改进建议|nice to have/i;

  if (p0Pattern.test(combined)) {
    return {
      label: 'priority:p0',
      reason: '检测到崩溃/卡死/数据丢失/主流程阻塞关键词，按阻塞级处理。',
    };
  }

  if (issueType === 'bug' && p1Pattern.test(combined)) {
    return {
      label: 'priority:p1',
      reason: '影响核心流程但通常可绕过，按高优先级缺陷处理。',
    };
  }

  if (issueType === 'enhancement' && p3Pattern.test(combined)) {
    return {
      label: 'priority:p3',
      reason: '偏体验优化或长期改进，进入低优先级 backlog。',
    };
  }

  if (issueType === 'bug') {
    return {
      label: 'priority:p1',
      reason: '缺陷默认高于功能需求，按 p1 处理。',
    };
  }

  return {
    label: 'priority:p2',
    reason: '常规功能需求，按 p2 排序。',
  };
}

function tokenize(text) {
  const lowered = normalizeText(text).toLowerCase();
  const tokens = lowered.match(/[\p{L}\p{N}]+/gu) || [];
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'to',
    'is',
    'are',
    'of',
    'and',
    'or',
    'in',
    'on',
    'for',
    'with',
    'this',
    'that',
    'issue',
    'bug',
    'feature',
    '我',
    '你',
    '他',
    '她',
    '它',
    '的',
    '了',
    '和',
    '与',
    '是',
    '在',
    '有',
    '请',
    '一个',
    '我们',
    '你们',
    '问题',
    '需求',
    '功能',
  ]);
  return new Set(tokens.filter((item) => item.length > 1 && !stopWords.has(item)));
}

function jaccardSimilarity(left, right) {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}

function findBestDuplicateCandidate(sourceIssue, allOpenIssues, sourceType) {
  const sourceTokens = tokenize(`${sourceIssue.title}\n${sourceIssue.body}`);
  let bestCandidate = null;
  let bestScore = 0;

  for (const candidate of allOpenIssues) {
    if (candidate.number === sourceIssue.number) {
      continue;
    }
    if (candidate.number > sourceIssue.number) {
      continue;
    }
    const candidateType = parseIssueType(candidate);
    if (candidateType !== sourceType) {
      continue;
    }
    const score = jaccardSimilarity(sourceTokens, tokenize(`${candidate.title}\n${candidate.body}`));
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    return null;
  }
  return { candidate: bestCandidate, similarity: bestScore };
}

async function aiDuplicateDecision(config, sourceIssue, candidateIssue) {
  const systemPrompt = [
    'You are an issue triage assistant.',
    'You must only output JSON and no additional text.',
    'Do not output chain-of-thought.',
  ].join(' ');

  const userPrompt = [
    'Determine whether source issue is a duplicate of candidate issue.',
    'Output JSON with shape:',
    '{"is_duplicate":boolean,"confidence":number,"canonical_issue_number":number,"reason":"..."}',
    'Rules:',
    '1) confidence must be between 0 and 1.',
    '2) canonical_issue_number must be candidate issue number when duplicate.',
    '3) reason should be concise and factual.',
    '',
    `Source #${sourceIssue.number}: ${sourceIssue.title}`,
    `Source body: ${bodySnippet(sourceIssue.body)}`,
    '',
    `Candidate #${candidateIssue.number}: ${candidateIssue.title}`,
    `Candidate body: ${bodySnippet(candidateIssue.body)}`,
  ].join('\n');

  return callJsonWithAi({
    config,
    systemPrompt,
    userPrompt,
    operationName: `duplicate-check-${sourceIssue.number}-${candidateIssue.number}`,
    guard: (payload) =>
      typeof payload === 'object' &&
      typeof payload?.is_duplicate === 'boolean' &&
      typeof payload?.confidence === 'number' &&
      Number.isFinite(payload?.confidence) &&
      typeof payload?.canonical_issue_number === 'number' &&
      typeof payload?.reason === 'string',
  });
}

function issuePriorityFromLabels(issue, fallbackPriorityLabel) {
  const labels = getIssueLabelNames(issue);
  for (const item of PRIORITY_LABELS) {
    if (labels.includes(item)) {
      return item;
    }
  }
  return fallbackPriorityLabel;
}

function ensureLabelSet() {
  const current = readJsonFromGh(['label', 'list', '--limit', '200', '--json', 'name']);
  const existing = new Set((current || []).map((item) => item.name));
  for (const label of REQUIRED_LABELS) {
    if (existing.has(label.name)) {
      continue;
    }
    if (READ_ONLY) {
      log(`[read-only] missing label detected: ${label.name}`);
      continue;
    }
    runGh(['label', 'create', label.name, '--color', label.color, '--description', label.description]);
    log(`Created label: ${label.name}`);
  }
}

function listOpenIssues() {
  return readJsonFromGh([
    'issue',
    'list',
    '--state',
    'open',
    '--limit',
    '500',
    '--json',
    'number,title,body,labels,createdAt,updatedAt,url',
  ]);
}

function listClosedDuplicateIssues() {
  return readJsonFromGh([
    'issue',
    'list',
    '--state',
    'closed',
    '--label',
    'duplicate',
    '--limit',
    '40',
    '--json',
    'number,title,url,closedAt',
  ]);
}

function pickTargetIssues(allOpenIssues) {
  if (TRIAGE_MODE === 'full') {
    return allOpenIssues;
  }

  if (TRIAGE_MODE === 'retry') {
    return allOpenIssues.filter((issue) => getIssueLabelNames(issue).includes(TRIAGE_LABEL));
  }

  const now = Date.now();
  const thresholdMs = LOOKBACK_HOURS * 60 * 60 * 1000;
  return allOpenIssues.filter((issue) => {
    const updatedAt = new Date(issue.updatedAt || issue.createdAt).getTime();
    const hasRetryLabel = getIssueLabelNames(issue).includes(TRIAGE_LABEL);
    if (hasRetryLabel) {
      return true;
    }
    if (!Number.isFinite(updatedAt)) {
      return false;
    }
    return now - updatedAt <= thresholdMs;
  });
}

function editIssueLabels(issueNumber, { add = [], remove = [] }) {
  const args = ['issue', 'edit', String(issueNumber)];
  for (const label of add) {
    args.push('--add-label', label);
  }
  for (const label of remove) {
    args.push('--remove-label', label);
  }
  if (add.length === 0 && remove.length === 0) {
    return;
  }
  if (READ_ONLY) {
    log(`[read-only] skip label edit for #${issueNumber} add=[${add.join(',')}] remove=[${remove.join(',')}]`);
    return;
  }
  const result = runGh(args, { allowFailure: true });
  if (result.status !== 0) {
    log(`Label edit skipped for #${issueNumber}: ${result.stderr || result.stdout}`);
  }
}

function ensureTypeAndPriorityLabels(issue, issueType, priorityLabel) {
  const currentLabels = new Set(getIssueLabelNames(issue));
  const add = [];
  const remove = [];

  if (!currentLabels.has(issueType)) {
    add.push(issueType);
  }

  const oppositeType = issueType === 'bug' ? 'enhancement' : 'bug';
  if (currentLabels.has(oppositeType)) {
    remove.push(oppositeType);
  }

  for (const label of PRIORITY_LABELS) {
    if (label === priorityLabel) {
      if (!currentLabels.has(label)) {
        add.push(label);
      }
      continue;
    }
    if (currentLabels.has(label)) {
      remove.push(label);
    }
  }

  editIssueLabels(issue.number, { add, remove });
}

function setRetryLabel(issueNumber, shouldSet) {
  if (shouldSet) {
    editIssueLabels(issueNumber, { add: [TRIAGE_LABEL] });
  } else {
    editIssueLabels(issueNumber, { remove: [TRIAGE_LABEL] });
  }
}

function maybeCloseAsDuplicate({ sourceIssue, canonicalIssue, reason, dryRunClose }) {
  const sourceUrl = sourceIssue.url;
  const canonicalUrl = canonicalIssue.url;
  const commentBody = [
    '该 issue 与现有 issue 重复，已归并到主 issue 跟踪。',
    '',
    `- 主 Issue: ${canonicalUrl}`,
    `- 归并依据: ${reason || '标题与描述高度重合。'}`,
    '',
    dryRunClose ? '当前处于灰度模式（只评论不自动关闭）。' : '如判断有误，可随时重新打开此 issue。',
  ].join('\n');

  if (READ_ONLY) {
    log(`[read-only] duplicate #${sourceIssue.number} -> #${canonicalIssue.number} (${reason || 'no-reason'})`);
    return;
  }

  editIssueLabels(sourceIssue.number, { add: ['duplicate'], remove: [DUPLICATE_CANDIDATE_LABEL] });
  runGh(['issue', 'comment', String(sourceIssue.number), '--body', commentBody]);

  if (!dryRunClose) {
    runGh(['issue', 'close', String(sourceIssue.number)]);
    log(`Closed duplicate #${sourceIssue.number} -> #${canonicalIssue.number}`);
  } else {
    log(`Dry-run close duplicate #${sourceIssue.number} -> #${canonicalIssue.number} (${sourceUrl})`);
  }
}

async function runDuplicateDetection({ aiConfig, allOpenIssues, targetIssues }) {
  if (!hasAiProvider(aiConfig)) {
    log('AI provider unavailable. Duplicate auto-close degraded to candidate labeling only.');
    return { closed: 0, candidates: 0, aiFailures: 0 };
  }

  let closed = 0;
  let candidates = 0;
  let aiFailures = 0;

  const openIssueMap = new Map(allOpenIssues.map((issue) => [issue.number, issue]));

  for (const issue of targetIssues) {
    const issueType = parseIssueType(issue);
    const candidatePack = findBestDuplicateCandidate(issue, allOpenIssues, issueType);
    if (!candidatePack) {
      continue;
    }
    if (candidatePack.similarity < DUPLICATE_SIMILARITY) {
      continue;
    }

    const candidate = candidatePack.candidate;
    try {
      const aiResult = await aiDuplicateDecision(aiConfig, issue, candidate);
      const confidence = Number(aiResult.confidence) || 0;
      const canonicalIssue = openIssueMap.get(Number(aiResult.canonical_issue_number)) || candidate;
      const canonicalType = parseIssueType(canonicalIssue);

      if (
        aiResult.is_duplicate === true &&
        confidence >= DUPLICATE_CONFIDENCE &&
        candidatePack.similarity >= DUPLICATE_SIMILARITY &&
        canonicalType === issueType &&
        canonicalIssue.number !== issue.number
      ) {
        maybeCloseAsDuplicate({
          sourceIssue: issue,
          canonicalIssue,
          reason: aiResult.reason,
          dryRunClose: DRY_RUN_CLOSE,
        });
        setRetryLabel(issue.number, false);
        closed += DRY_RUN_CLOSE ? 0 : 1;
      } else {
        editIssueLabels(issue.number, { add: [DUPLICATE_CANDIDATE_LABEL] });
        setRetryLabel(issue.number, false);
        candidates += 1;
      }
    } catch (error) {
      aiFailures += 1;
      setRetryLabel(issue.number, true);
      log(`AI duplicate check failed for #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { closed, candidates, aiFailures };
}

function sortIssuesForTodo(issues) {
  return [...issues].sort((left, right) => {
    const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
    const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
    return rightTime - leftTime;
  });
}

function buildTodoPayload(allOpenIssues, closedDuplicates) {
  const sections = { p0: [], p1: [], p2: [], p3: [] };

  for (const issue of allOpenIssues) {
    const issueType = parseIssueType(issue);
    const priority = computePriority(issue, issueType);
    const priorityLabel = issuePriorityFromLabels(issue, priority.label);
    const key = priorityLabel.replace('priority:', '');

    const labels = getIssueLabelNames(issue);
    sections[key].push({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      labels,
      reason: priority.reason,
      updatedAt: issue.updatedAt || issue.createdAt || '',
    });
  }

  for (const key of Object.keys(sections)) {
    sections[key] = sortIssuesForTodo(sections[key]);
  }

  const duplicates = (closedDuplicates || []).map((item) => ({
    number: item.number,
    title: item.title,
    url: item.url,
    canonicalNumber: null,
  }));

  return { sections, duplicates };
}

function writeTodoFile(markdown) {
  const fullPath = join(PROJECT_ROOT, TODO_FILE_PATH);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const previous = existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : '';
  if (previous === markdown) {
    return { changed: false, fullPath };
  }
  writeFileSync(fullPath, markdown, 'utf-8');
  return { changed: true, fullPath };
}

function commitAndPushTodo(defaultBranch) {
  runGit(['add', TODO_FILE_PATH]);
  const commitResult = runGit(['commit', '-m', 'chore(issue-bot): update docs/todo/issues.md'], { allowFailure: true });
  if (commitResult.status !== 0) {
    log('No git commit created for todo update.');
    return;
  }

  const directPush = runGit(['push', 'origin', `HEAD:${defaultBranch}`], { allowFailure: true });
  if (directPush.status === 0) {
    log(`Pushed todo update directly to ${defaultBranch}.`);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const fallbackBranch = `bot/issue-todo-${timestamp}`;
  runGit(['checkout', '-b', fallbackBranch]);
  runGit(['push', '-u', 'origin', fallbackBranch]);
  const prTitle = 'chore(issue-bot): update docs/todo/issues.md';
  const prBody = [
    'Auto-generated fallback PR because direct push was blocked.',
    '',
    '- Source: issue-triage workflow',
    `- Generated at: ${new Date().toISOString()}`,
  ].join('\n');
  runGh(
    ['pr', 'create', '--base', defaultBranch, '--head', fallbackBranch, '--title', prTitle, '--body', prBody],
    { allowFailure: true },
  );
  log(`Direct push blocked. Opened fallback branch ${fallbackBranch}.`);
}

async function main() {
  log(`Mode: ${TRIAGE_MODE}`);
  if (READ_ONLY) {
    log('Running in read-only mode. No issue/comment/label mutations will be applied.');
  }

  const repoInfo = readJsonFromGh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef']);
  const repository = repoInfo?.nameWithOwner || '';
  const defaultBranch = repoInfo?.defaultBranchRef?.name || 'master';

  ensureLabelSet();
  const allOpenIssues = listOpenIssues();
  const targetIssues = pickTargetIssues(allOpenIssues);
  log(`Open issues: ${allOpenIssues.length}, target issues: ${targetIssues.length}`);

  const aiConfig = resolveAiProviderConfig(process.env);

  let classifiedCount = 0;
  for (const issue of targetIssues) {
    const issueType = parseIssueType(issue);
    const priority = computePriority(issue, issueType);
    ensureTypeAndPriorityLabels(issue, issueType, priority.label);
    setRetryLabel(issue.number, false);
    classifiedCount += 1;
  }

  const duplicateStats = await runDuplicateDetection({ aiConfig, allOpenIssues, targetIssues });

  const refreshedOpenIssues = listOpenIssues();
  const closedDuplicates = listClosedDuplicateIssues();
  const todoPayload = buildTodoPayload(refreshedOpenIssues, closedDuplicates);
  const markdown = renderTodoMarkdown({
    generatedAt: new Date().toISOString(),
    repository,
    sections: todoPayload.sections,
    duplicates: todoPayload.duplicates,
  });

  const writeResult = writeTodoFile(markdown);
  if (writeResult.changed) {
    log(`Updated ${TODO_FILE_PATH}`);
    if (!SKIP_GIT_WRITE && !READ_ONLY) {
      commitAndPushTodo(defaultBranch);
    } else {
      log('Skip git write or read-only mode is enabled; not committing todo changes.');
    }
  } else {
    log(`${TODO_FILE_PATH} unchanged.`);
  }

  log(
    `Summary: classified=${classifiedCount}, duplicate_closed=${duplicateStats.closed}, duplicate_candidates=${duplicateStats.candidates}, ai_failures=${duplicateStats.aiFailures}`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[issue-triage] fatal: ${message}\n`);
  process.exit(1);
});
