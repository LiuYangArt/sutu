#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function defaultTracePath() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? '';
    return path.join(appData, 'com.sutu', 'debug', 'tablet-input-trace.ndjson');
  }
  if (process.platform === 'darwin') {
    const home = process.env.HOME ?? '';
    return path.join(
      home,
      'Library',
      'Application Support',
      'com.sutu',
      'debug',
      'tablet-input-trace.ndjson'
    );
  }
  const home = process.env.HOME ?? '';
  return path.join(home, '.config', 'com.sutu', 'debug', 'tablet-input-trace.ndjson');
}

function parseArgs(argv) {
  const parsed = { file: defaultTracePath(), tail: 12000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) {
      parsed.file = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--tail' && argv[i + 1]) {
      const n = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(n) && n > 0) parsed.tail = n;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

function printHelp() {
  console.log('Usage: node scripts/debug/analyze-tablet-pipeline-lag.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --file <path>   Trace ndjson path');
  console.log('  --tail <n>      Analyze last n lines (default: 12000)');
  console.log('  --help          Show this help');
}

function safeParseLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function formatMs(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(2)}ms`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(3)}%`;
}

function summarizeLags(label, arr) {
  if (arr.length === 0) {
    console.log(`[Lag] ${label}: no data`);
    return;
  }
  const sorted = [...arr].sort((a, b) => a - b);
  const p50 = quantile(sorted, 0.5);
  const p90 = quantile(sorted, 0.9);
  const p99 = quantile(sorted, 0.99);
  const max = sorted[sorted.length - 1];
  console.log(
    `[Lag] ${label}: n=${arr.length} p50=${formatMs(p50)} p90=${formatMs(p90)} p99=${formatMs(
      p99
    )} max=${formatMs(max)}`
  );
}

function getMsLag(traceEpochMs, hostTimeUs) {
  if (!Number.isFinite(traceEpochMs) || !Number.isFinite(hostTimeUs)) return null;
  return traceEpochMs - hostTimeUs / 1000;
}

function addStrokeLag(map, strokeId, lag) {
  if (!Number.isFinite(strokeId) || !Number.isFinite(lag)) return;
  const key = Number(strokeId);
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(lag);
}

function incMap(map, key) {
  if (typeof key !== 'string' || key.length === 0) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printPerStroke(label, map) {
  const ids = [...map.keys()].sort((a, b) => a - b);
  if (ids.length === 0) {
    console.log(`[Lag] ${label} per-stroke: no data`);
    return;
  }
  console.log(`[Lag] ${label} per-stroke:`);
  for (const id of ids) {
    const arr = map.get(id) ?? [];
    if (arr.length === 0) continue;
    const sorted = [...arr].sort((a, b) => a - b);
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const p90 = quantile(sorted, 0.9) ?? avg;
    const max = sorted[sorted.length - 1] ?? avg;
    console.log(
      `  stroke=${id} n=${arr.length} avg=${formatMs(avg)} p90=${formatMs(p90)} max=${formatMs(
        max
      )}`
    );
  }
}

function printTopCounts(label, map) {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    console.log(`[Lag] ${label}: no data`);
    return;
  }
  console.log(`[Lag] ${label}:`);
  for (const [key, count] of entries.slice(0, 8)) {
    console.log(`  ${key}: ${count}`);
  }
}

function summarizeCadenceFromDeltas(label, arrMs) {
  if (arrMs.length === 0) {
    console.log(`[Cadence] ${label}: no data`);
    return;
  }
  const sorted = [...arrMs].sort((a, b) => a - b);
  const p50 = quantile(sorted, 0.5);
  const p90 = quantile(sorted, 0.9);
  const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  const hzP50 = Number.isFinite(p50) && p50 > 0 ? 1000 / p50 : null;
  const hzAvg = Number.isFinite(avg) && avg > 0 ? 1000 / avg : null;
  console.log(
    `[Cadence] ${label}: n=${arrMs.length} p50=${formatMs(p50)} p90=${formatMs(
      p90
    )} avg=${formatMs(avg)} hz_p50=${Number.isFinite(hzP50) ? hzP50.toFixed(1) : 'n/a'} hz_avg=${
      Number.isFinite(hzAvg) ? hzAvg.toFixed(1) : 'n/a'
    }`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.file)) {
    console.error(`[Trace] file not found: ${args.file}`);
    process.exit(1);
  }

  const allLines = fs.readFileSync(args.file, 'utf8').split(/\r?\n/);
  const tailLines = allLines.slice(Math.max(0, allLines.length - args.tail));

  const recvLags = [];
  const recvByStroke = new Map();
  const consumeLags = [];
  const consumeByStroke = new Map();
  const ingressConsumeLags = [];
  const emitterOldestLags = [];
  const emitterNewestLags = [];
  const emitterTransportLags = [];
  const delayedBatches = [];
  const emitterBackendCounts = new Map();
  const emitterFirstSourceCounts = new Map();
  const emitterLastSourceCounts = new Map();
  const emitterCadenceByBackend = new Map();
  const lastEmitterSampleByBackend = new Map();
  const firstSeedPressureByStroke = new Map();
  const firstConsumedPressureByStroke = new Map();
  const firstDabPressureErrors = [];

  let nativeEmptyWithContactCount = 0;
  let nativeConsumeSampleCount = 0;
  let nativePumpConsumeCount = 0;
  let spacePanDrawLeakCount = 0;
  let latestV3Diagnostics = null;

  let parsedRows = 0;
  let skippedRows = 0;

  for (const line of tailLines) {
    const row = safeParseLine(line);
    if (!row) {
      skippedRows += 1;
      continue;
    }
    parsedRows += 1;
    const scope = row.scope;
    const traceEpochMs =
      typeof row.trace_epoch_ms === 'number' && Number.isFinite(row.trace_epoch_ms)
        ? row.trace_epoch_ms
        : null;
    if (row.v3_diagnostics && typeof row.v3_diagnostics === 'object') {
      latestV3Diagnostics = row.v3_diagnostics;
    }

    if (scope === 'frontend.recv.native_v3') {
      const lag = getMsLag(traceEpochMs, row.host_time_us);
      if (lag !== null) {
        recvLags.push(lag);
        addStrokeLag(recvByStroke, row.stroke_id, lag);
      }
      continue;
    }

    if (scope === 'frontend.pointerdown.native_seed') {
      const strokeId = Number(row.stroke_id);
      const pressure = Number(row.pressure_0_1);
      if (Number.isFinite(strokeId) && Number.isFinite(pressure) && !firstSeedPressureByStroke.has(strokeId)) {
        firstSeedPressureByStroke.set(strokeId, pressure);
      }
      continue;
    }

    if (scope === 'frontend.pointermove.native_empty' && row.pointer_contact) {
      nativeEmptyWithContactCount += 1;
      continue;
    }

    if (scope === 'frontend.anomaly.space_pan_draw_leak') {
      const count = Number(row.count);
      spacePanDrawLeakCount += Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
      continue;
    }

    if (
      scope === 'frontend.pointermove.native_consume' ||
      scope === 'frontend.pointerup.native_consume' ||
      scope === 'frontend.ingress.native_tick_consume' ||
      scope === 'frontend.native_pump.consume'
    ) {
      const lag = getMsLag(traceEpochMs, row.host_time_us);
      if (lag !== null) {
        consumeLags.push(lag);
        ingressConsumeLags.push(lag);
        addStrokeLag(consumeByStroke, row.stroke_id, lag);
      }
      nativeConsumeSampleCount += 1;
      if (scope === 'frontend.native_pump.consume') {
        nativePumpConsumeCount += 1;
      }
      const strokeId = Number(row.stroke_id);
      const pressure = Number(row.pressure_0_1);
      if (
        Number.isFinite(strokeId) &&
        Number.isFinite(pressure) &&
        !firstConsumedPressureByStroke.has(strokeId)
      ) {
        firstConsumedPressureByStroke.set(strokeId, pressure);
        const seedPressure = firstSeedPressureByStroke.get(strokeId);
        if (Number.isFinite(seedPressure)) {
          firstDabPressureErrors.push(Math.abs(pressure - seedPressure));
        }
      }
      continue;
    }

    if (scope === 'frontend.recv.emitter_batch_v1') {
      const oldestUs = row.oldest_input_latency_us;
      const newestUs = row.newest_input_latency_us;
      const emittedUs = row.emit_completed_time_us;
      const transportLag =
        Number.isFinite(traceEpochMs) && Number.isFinite(emittedUs)
          ? traceEpochMs - emittedUs / 1000
          : null;

      if (Number.isFinite(oldestUs)) emitterOldestLags.push(oldestUs / 1000);
      if (Number.isFinite(newestUs)) emitterNewestLags.push(newestUs / 1000);
      if (transportLag !== null) emitterTransportLags.push(transportLag);
      incMap(emitterBackendCounts, row.backend);
      incMap(emitterFirstSourceCounts, row.first_source);
      incMap(emitterLastSourceCounts, row.last_source);

      const backendKey =
        typeof row.backend === 'string' && row.backend.length > 0 ? row.backend : 'unknown';
      const inputCount = Number(row.input_event_count);
      const minSeq = Number(row.min_seq);
      const hostTimeUs = Number(row.min_host_time_us);
      if (
        Number.isFinite(inputCount) &&
        inputCount > 0 &&
        Number.isFinite(minSeq) &&
        Number.isFinite(hostTimeUs)
      ) {
        const previous = lastEmitterSampleByBackend.get(backendKey);
        if (previous && minSeq === previous.seq + 1) {
          const deltaMs = (hostTimeUs - previous.hostTimeUs) / 1000;
          if (Number.isFinite(deltaMs) && deltaMs > 0 && deltaMs <= 200) {
            if (!emitterCadenceByBackend.has(backendKey)) {
              emitterCadenceByBackend.set(backendKey, []);
            }
            emitterCadenceByBackend.get(backendKey).push(deltaMs);
          }
        }
        lastEmitterSampleByBackend.set(backendKey, { seq: minSeq, hostTimeUs });
      }

      if ((Number.isFinite(oldestUs) && oldestUs / 1000 > 80) || (transportLag ?? 0) > 80) {
        delayedBatches.push({
          iso: row.trace_iso_time,
          firstStroke: row.first_stroke_id,
          lastStroke: row.last_stroke_id,
          minSeq: row.min_seq,
          maxSeq: row.max_seq,
          oldestLagMs: Number.isFinite(oldestUs) ? oldestUs / 1000 : null,
          transportLagMs: transportLag,
          inputCount: row.input_event_count,
        });
      }
    }
  }

  console.log(`[Trace] file=${args.file}`);
  console.log(
    `[Trace] lines_scanned=${tailLines.length} parsed_rows=${parsedRows} skipped_rows=${skippedRows}`
  );
  summarizeLags('frontend.recv.native_v3 (host->recv)', recvLags);
  summarizeLags('frontend.native_consume (host->consume)', consumeLags);
  summarizeLags('frontend.ingress.consume (host->ingress)', ingressConsumeLags);
  summarizeLags('emitter oldest_input_latency (host->emit)', emitterOldestLags);
  summarizeLags('emitter newest_input_latency (host->emit)', emitterNewestLags);
  summarizeLags('emitter transport (emit->frontend.recv)', emitterTransportLags);

  printPerStroke('frontend.recv.native_v3', recvByStroke);
  printPerStroke('frontend.native_consume', consumeByStroke);
  printTopCounts('emitter backend distribution', emitterBackendCounts);
  printTopCounts('emitter first_source distribution', emitterFirstSourceCounts);
  printTopCounts('emitter last_source distribution', emitterLastSourceCounts);
  for (const [backend, cadenceDeltasMs] of emitterCadenceByBackend.entries()) {
    summarizeCadenceFromDeltas(`backend=${backend} continuous_host_interval`, cadenceDeltasMs);
  }

  const emitTransportSorted = [...emitterTransportLags].sort((a, b) => a - b);
  const emitToFrontendRecvP95Ms = quantile(emitTransportSorted, 0.95);
  const nativeEmptyDenominator = nativeConsumeSampleCount + nativeEmptyWithContactCount;
  const nativeEmptyWithContactRate =
    nativeEmptyDenominator > 0 ? nativeEmptyWithContactCount / nativeEmptyDenominator : null;
  const firstDabErrorSorted = [...firstDabPressureErrors].sort((a, b) => a - b);
  const firstDabPressureErrorP95 = quantile(firstDabErrorSorted, 0.95);
  const ingressConsumeSorted = [...ingressConsumeLags].sort((a, b) => a - b);
  const hostToIngressConsumeP95Ms = quantile(ingressConsumeSorted, 0.95);
  const nativePumpPrimaryConsumeRate =
    nativeConsumeSampleCount > 0 ? nativePumpConsumeCount / nativeConsumeSampleCount : null;
  const pressureClampRate =
    latestV3Diagnostics &&
    Number.isFinite(latestV3Diagnostics.pressure_total_count) &&
    latestV3Diagnostics.pressure_total_count > 0 &&
    Number.isFinite(latestV3Diagnostics.pressure_clamp_count)
      ? latestV3Diagnostics.pressure_clamp_count / latestV3Diagnostics.pressure_total_count
      : null;

  console.log('[Blocking] threshold checks:');
  console.log(
    `  native_empty_with_contact_rate=${formatPercent(nativeEmptyWithContactRate)} (threshold <= 0.500%)`
  );
  console.log(
    `  pressure_clamp_rate=${formatPercent(pressureClampRate)} (threshold <= 0.100%)`
  );
  console.log(
    `  first_dab_pressure_error_p95=${Number.isFinite(firstDabPressureErrorP95) ? firstDabPressureErrorP95.toFixed(4) : 'n/a'} (threshold <= 0.12)`
  );
  console.log(
    `  emit_to_frontend_recv_p95_ms=${formatMs(emitToFrontendRecvP95Ms)} (threshold <= 8.00ms)`
  );
  console.log(
    `  host_to_ingress_consume_p95_ms=${formatMs(hostToIngressConsumeP95Ms)} (threshold <= 12.00ms)`
  );
  console.log(
    `  native_pump_primary_consume_rate=${formatPercent(nativePumpPrimaryConsumeRate)} (threshold = 0.000%)`
  );
  console.log(`  space_pan_draw_leak_count=${spacePanDrawLeakCount} (threshold = 0)`);
  if (!latestV3Diagnostics) {
    console.log('  [Hint] pressure_clamp_rate requires v3_diagnostics snapshot rows in trace.');
  }

  if (delayedBatches.length > 0) {
    console.log('[Lag] Delayed emitter batches (top 12 by oldest/transport lag):');
    delayedBatches
      .sort((a, b) => {
        const aLag = Math.max(a.oldestLagMs ?? 0, a.transportLagMs ?? 0);
        const bLag = Math.max(b.oldestLagMs ?? 0, b.transportLagMs ?? 0);
        return bLag - aLag;
      })
      .slice(0, 12)
      .forEach((b) => {
        console.log(
          `  t=${b.iso} stroke=${b.firstStroke}->${b.lastStroke} seq=${b.minSeq}->${b.maxSeq} input_count=${b.inputCount} host_to_emit=${formatMs(
            b.oldestLagMs
          )} emit_to_recv=${formatMs(b.transportLagMs)}`
        );
      });
  } else {
    console.log('[Lag] Delayed emitter batches: none');
  }

  if (emitterOldestLags.length === 0 || emitterTransportLags.length === 0) {
    console.log(
      '[Hint] No emitter metrics found. Update to build with `tablet-emitter-metrics-v1` instrumentation, then recapture trace.'
    );
  }
}

main();
