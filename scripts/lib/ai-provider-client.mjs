#!/usr/bin/env node

import { setTimeout as sleep } from 'node:timers/promises';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAYS_MS = [30_000, 120_000, 480_000];

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseRetryDelays(value) {
  if (!value) {
    return [...DEFAULT_RETRY_DELAYS_MS];
  }
  const parsed = String(value)
    .split(',')
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item >= 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_RETRY_DELAYS_MS];
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  const suffix = String(path || '').trim();
  if (!base) {
    throw new Error('AI API base URL is required.');
  }
  if (!suffix) {
    throw new Error('AI API path is required.');
  }
  if (/^https?:\/\//i.test(suffix)) {
    return suffix;
  }
  return `${base}/${suffix.replace(/^\/+/, '')}`;
}

function resolveAiProviderConfig(env = process.env) {
  return {
    apiKey: String(env.RELEASE_NOTES_API_KEY || env.OPENAI_API_KEY || '').trim(),
    model: String(env.RELEASE_NOTES_MODEL || env.OPENAI_MODEL || 'gpt-4.1-mini').trim(),
    apiBaseUrl: String(env.RELEASE_NOTES_API_BASE_URL || env.OPENAI_API_BASE_URL || 'https://api.openai.com').trim(),
    apiPath: String(env.RELEASE_NOTES_API_PATH || env.OPENAI_API_PATH || '/v1/chat/completions').trim(),
    timeoutMs: parseNumber(env.ISSUE_AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    retryDelaysMs: parseRetryDelays(env.ISSUE_AI_RETRY_DELAYS_MS),
  };
}

function hasAiProvider(config) {
  return Boolean(config?.apiKey);
}

function extractTextFromChatCompletions(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
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
}

function stripThinkingArtifacts(text) {
  if (!text) {
    return '';
  }
  let output = String(text).replace(/\r\n/g, '\n');
  output = output.replace(/<think>[\s\S]*?<\/think>/gi, '');
  output = output.replace(/```(?:thinking|analysis|reasoning)[\s\S]*?```/gi, '');
  output = output.replace(
    /^\s*(thinking|analysis|reasoning|chain[- ]of[- ]thought|thoughts?|思考过程|推理过程|分析过程)\s*[:：].*$/gim,
    '',
  );
  return output.trim();
}

function extractFirstJsonObject(text) {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start < 0) {
    return '';
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
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
        return source.slice(start, index + 1);
      }
    }
  }
  return '';
}

async function callJsonWithAi({
  config,
  systemPrompt,
  userPrompt,
  temperature = 0.1,
  operationName = 'ai-request',
  guard,
}) {
  if (!hasAiProvider(config)) {
    throw new Error(`${operationName}: missing AI API key.`);
  }

  const endpoint = joinUrl(config.apiBaseUrl, config.apiPath);
  const retryDelaysMs = Array.isArray(config.retryDelaysMs) ? config.retryDelaysMs : [];
  let lastError = null;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs || DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          stream: false,
          temperature,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${operationName}: API ${response.status} ${errorText.slice(0, 240)}`);
      }

      const payload = await response.json();
      const rawText = extractTextFromChatCompletions(payload);
      if (!rawText) {
        throw new Error(`${operationName}: empty AI response.`);
      }

      const cleaned = stripThinkingArtifacts(rawText);
      const objectText = extractFirstJsonObject(cleaned) || cleaned;
      let parsed;
      try {
        parsed = JSON.parse(objectText);
      } catch {
        throw new Error(`${operationName}: response is not valid JSON.`);
      }

      if (typeof guard === 'function' && !guard(parsed)) {
        throw new Error(`${operationName}: response JSON failed guard check.`);
      }

      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < retryDelaysMs.length) {
        await sleep(retryDelaysMs[attempt]);
        continue;
      }
      break;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(`${operationName}: unknown error`);
}

export {
  callJsonWithAi,
  extractFirstJsonObject,
  extractTextFromChatCompletions,
  hasAiProvider,
  joinUrl,
  resolveAiProviderConfig,
  stripThinkingArtifacts,
};
