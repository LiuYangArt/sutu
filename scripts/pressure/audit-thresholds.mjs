#!/usr/bin/env node
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:1420',
    capture: '',
    baseline: 'krita-5.2-default-wintab',
    threshold: 'krita-pressure-thresholds.v1',
    thresholdFile: 'docs/testing/krita-pressure-thresholds.v1.json',
    runs: 30,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if (token === '--url' && next) {
      args.url = next;
      i += 1;
      continue;
    }
    if (token === '--capture' && next) {
      args.capture = next;
      i += 1;
      continue;
    }
    if (token === '--baseline' && next) {
      args.baseline = next;
      i += 1;
      continue;
    }
    if (token === '--threshold' && next) {
      args.threshold = next;
      i += 1;
      continue;
    }
    if (token === '--threshold-file' && next) {
      args.thresholdFile = next;
      i += 1;
      continue;
    }
    if (token === '--runs' && next) {
      const runs = Number.parseInt(next, 10);
      if (Number.isFinite(runs) && runs > 0) {
        args.runs = runs;
      }
      i += 1;
      continue;
    }
    if (token === '--help') {
      console.log(
        [
          'Usage: node scripts/pressure/audit-thresholds.mjs [options]',
          '',
          'Options:',
          '  --url <url>              App URL (default: http://127.0.0.1:1420)',
          '  --capture <path>         Capture JSON path (optional)',
          '  --baseline <version>     Baseline version',
          '  --threshold <version>    Threshold version',
          '  --threshold-file <path>  Threshold JSON file',
          '  --runs <n>               Number of runs (default: 30)',
        ].join('\n')
      );
      process.exit(0);
    }
  }

  return args;
}

function p99(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * 0.99)));
  return sorted[index] ?? 0;
}

function addMetric(map, key, value) {
  if (!Number.isFinite(value)) return;
  if (!map.has(key)) {
    map.set(key, []);
  }
  map.get(key).push(value);
}

function collectRunMetrics(collector, result) {
  const stage = result?.stage_metrics ?? {};
  const final = result?.final_metrics ?? {};
  const fast = result?.fast_windows_metrics ?? {};

  for (const [key, value] of Object.entries(stage)) {
    addMetric(collector, `stage.${key}`, value);
  }
  for (const [key, value] of Object.entries(final)) {
    addMetric(collector, `final.${key}`, value);
  }
  for (const [key, value] of Object.entries(fast)) {
    addMetric(collector, `fast.${key}`, value);
  }

  const presets = Array.isArray(result?.preset_results) ? result.preset_results : [];
  for (const preset of presets) {
    addMetric(collector, 'preset.sensor_map_mae', preset.sensor_map_mae);
    addMetric(collector, 'preset.sensor_map_p95', preset.sensor_map_p95);
    addMetric(collector, 'preset.combiner_output_mae', preset.combiner_output_mae);
    addMetric(collector, 'preset.combiner_output_p95', preset.combiner_output_p95);
  }
}

function flattenThresholds(thresholdsJson) {
  const out = new Map();
  for (const [section, sectionValue] of Object.entries(thresholdsJson)) {
    if (
      section !== 'stage' &&
      section !== 'final' &&
      section !== 'fast' &&
      section !== 'preset'
    ) {
      continue;
    }
    if (!sectionValue || typeof sectionValue !== 'object') continue;
    for (const [key, value] of Object.entries(sectionValue)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      const normalizedKey = key.endsWith('_max') ? key.slice(0, -4) : key;
      out.set(`${section}.${normalizedKey}`, value);
    }
  }
  return out;
}

function toMarkdown(payload) {
  const lines = [];
  lines.push('# Krita 压感阈值审计 v1');
  lines.push('');
  lines.push(`- 生成时间: ${payload.generated_at}`);
  lines.push(`- 运行次数: ${payload.runs}`);
  lines.push(`- baseline: ${payload.baseline_version}`);
  lines.push(`- threshold_version: ${payload.threshold_version}`);
  lines.push(`- run_id: ${payload.run_id}`);
  lines.push(`- 输入 hash: ${payload.input_hash}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 阈值检查结论: ${payload.audit_passed ? '通过' : '失败'}`);
  lines.push(`- 超限指标数: ${payload.violations.length}`);
  lines.push('');
  lines.push('## 指标对比（p99 vs 当前阈值）');
  lines.push('');
  lines.push('| metric | p99 | threshold | margin | status |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const row of payload.metric_rows) {
    lines.push(
      `| ${row.metric} | ${row.p99.toFixed(6)} | ${row.threshold.toFixed(6)} | ${row.margin.toFixed(6)} | ${row.status} |`
    );
  }
  if (payload.violations.length > 0) {
    lines.push('');
    lines.push('## 超限项');
    lines.push('');
    for (const item of payload.violations) {
      lines.push(`- ${item.metric}: p99=${item.p99.toFixed(6)}, threshold=${item.threshold.toFixed(6)}`);
    }
  }
  lines.push('');
  lines.push('## 审计说明');
  lines.push('');
  lines.push('- 口径: 同一 baseline/capture 进行多轮 gate，统计数值指标 p99。');
  lines.push('- 判定: 仅当所有指标 p99 <= 当前阈值时通过。');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const thresholdsJson = JSON.parse(await fs.readFile(args.thresholdFile, 'utf-8'));
  const thresholdMap = flattenThresholds(thresholdsJson);

  let captureInput = null;
  if (args.capture) {
    const raw = await fs.readFile(args.capture, 'utf-8');
    captureInput = JSON.parse(raw);
  }

  const browser = await chromium.launch({ headless: true });
  const collector = new Map();
  let inputHash = 'unknown';
  try {
    const page = await browser.newPage();
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__kritaPressureFullGate === 'function', null, {
      timeout: 60_000,
    });

    for (let i = 0; i < args.runs; i += 1) {
      const result = await page.evaluate(async ({ capture, baseline, threshold }) => {
        const modeSet = window.__kritaPressurePipelineModeSet;
        if (typeof modeSet === 'function') {
          modeSet({
            pressurePipelineV2Primary: true,
            pressurePipelineV2Shadow: false,
          });
        }
        const fn = window.__kritaPressureFullGate;
        if (typeof fn !== 'function') {
          throw new Error('window.__kritaPressureFullGate is not available');
        }
        return fn({
          capture,
          baselineVersion: baseline,
          thresholdVersion: threshold,
        });
      }, {
        capture: captureInput,
        baseline: args.baseline,
        threshold: args.threshold,
      });
      inputHash = result?.input_hash ?? inputHash;
      collectRunMetrics(collector, result);
    }
  } finally {
    await browser.close();
  }

  const metricRows = [];
  const violations = [];
  for (const [metric, values] of collector.entries()) {
    const p99Value = p99(values);
    const threshold = thresholdMap.get(metric);
    if (typeof threshold !== 'number') {
      continue;
    }
    const margin = threshold - p99Value;
    const status = margin >= 0 ? 'pass' : 'fail';
    const row = { metric, p99: p99Value, threshold, margin, status };
    metricRows.push(row);
    if (status === 'fail') {
      violations.push(row);
    }
  }
  metricRows.sort((a, b) => a.metric.localeCompare(b.metric));

  const runId = `kp_threshold_audit_${Date.now().toString(36)}`;
  const payload = {
    run_id: runId,
    generated_at: new Date().toISOString(),
    runs: args.runs,
    baseline_version: args.baseline,
    threshold_version: args.threshold,
    threshold_file: args.thresholdFile,
    input_hash: inputHash,
    audit_passed: violations.length === 0,
    metric_rows: metricRows,
    violations,
  };

  const artifactDir = path.join('artifacts', 'krita-pressure-full', runId);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, 'threshold_audit.json'), JSON.stringify(payload, null, 2), 'utf-8');

  const markdown = toMarkdown(payload);
  await fs.writeFile('docs/testing/krita-pressure-thresholds.v1-audit.md', markdown, 'utf-8');

  console.log(
    JSON.stringify(
      {
        run_id: runId,
        audit_passed: payload.audit_passed,
        violations: payload.violations.length,
        output_json: path.join(artifactDir, 'threshold_audit.json'),
        output_markdown: 'docs/testing/krita-pressure-thresholds.v1-audit.md',
      },
      null,
      2
    )
  );

  process.exit(payload.audit_passed ? 0 : 2);
}

main().catch((error) => {
  console.error('[audit-thresholds] failed:', error);
  process.exit(1);
});
