#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const parsed = {
    file: defaultTracePath(),
    tail: 12000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) {
      parsed.file = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--tail' && argv[i + 1]) {
      const value = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(value) && value > 0) {
        parsed.tail = value;
      }
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

function printHelp() {
  console.log('Usage: node scripts/debug/analyze-tablet-trace.mjs [options]');
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

function inc(map, key, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function getMsLag(traceEpochMs, hostTimeUs) {
  if (!Number.isFinite(traceEpochMs) || !Number.isFinite(hostTimeUs)) return null;
  return traceEpochMs - hostTimeUs / 1000;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(3)}%`;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(2)}ms`;
}

function getStrokeCounter(map, strokeId) {
  const id = Number(strokeId);
  if (!Number.isFinite(id)) return null;
  if (!map.has(id)) {
    map.set(id, {
      strokeId: id,
      firstIso: null,
      lastIso: null,
      recvNative: 0,
      domDown: 0,
      domMove: 0,
      domUp: 0,
      nativeConsume: 0,
      nativePumpStart: 0,
      nativePumpConsume: 0,
      canvasConsume: 0,
      canvasTailConsume: 0,
    });
  }
  return map.get(id);
}

function updateStrokeTime(counter, row) {
  const iso = typeof row.trace_iso_time === 'string' ? row.trace_iso_time : null;
  if (!iso) return;
  if (!counter.firstIso || iso < counter.firstIso) counter.firstIso = iso;
  if (!counter.lastIso || iso > counter.lastIso) counter.lastIso = iso;
}

function classifyStroke(counter) {
  if (counter.recvNative > 0 && counter.nativeConsume === 0) {
    return 'DROP_BEFORE_CONSUME';
  }
  if (counter.recvNative > 0 && counter.domDown === 0 && counter.nativePumpStart > 0) {
    return 'CONSUMED_BY_NATIVE_PUMP';
  }
  if (counter.recvNative > 0 && counter.domDown === 0 && counter.nativeConsume > 0) {
    return 'NO_DOM_DOWN_BUT_CONSUMED';
  }
  if (counter.recvNative > 0 && counter.nativeConsume > 0) {
    return 'OK';
  }
  return 'UNKNOWN';
}

function printScopeTop(scopeCounts, limit = 20) {
  const entries = [...scopeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  console.log('[Trace] Top scopes:');
  for (const [scope, count] of entries) {
    console.log(`  ${scope}: ${count}`);
  }
}

function printStrokeSummary(strokeMap) {
  const rows = [...strokeMap.values()].sort((a, b) => a.strokeId - b.strokeId);
  console.log('[Trace] Stroke summary:');
  if (rows.length === 0) {
    console.log('  (no stroke_id rows found)');
    return;
  }

  for (const row of rows) {
    const verdict = classifyStroke(row);
    console.log(
      [
        `  stroke=${row.strokeId}`,
        `recv_native=${row.recvNative}`,
        `dom_down=${row.domDown}`,
        `dom_move=${row.domMove}`,
        `dom_up=${row.domUp}`,
        `native_consume=${row.nativeConsume}`,
        `pump_start=${row.nativePumpStart}`,
        `pump_consume=${row.nativePumpConsume}`,
        `canvas_consume=${row.canvasConsume}`,
        `tail_consume=${row.canvasTailConsume}`,
        `verdict=${verdict}`,
      ].join(' ')
    );
  }
}

function printSuspiciousStrokes(strokeMap) {
  const suspicious = [...strokeMap.values()]
    .filter((row) => classifyStroke(row) !== 'OK')
    .sort((a, b) => a.strokeId - b.strokeId);

  console.log('[Trace] Suspicious strokes:');
  if (suspicious.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const row of suspicious) {
    console.log(
      `  stroke=${row.strokeId} verdict=${classifyStroke(row)} first=${row.firstIso ?? 'n/a'} last=${row.lastIso ?? 'n/a'}`
    );
  }
}

const PRIMARY_NATIVE_CONSUME_SCOPES = new Set([
  'frontend.pointermove.native_consume',
  'frontend.pointerup.native_consume',
  'frontend.ingress.native_tick_consume',
  'frontend.native_pump.consume',
]);

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.file)) {
    console.error(`[Trace] file not found: ${args.file}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(args.file, 'utf8');
  const allLines = raw.split(/\r?\n/);
  const lines = allLines.slice(Math.max(0, allLines.length - args.tail));

  const scopeCounts = new Map();
  const strokeCounters = new Map();
  const anomalyCounts = new Map();
  const firstSeedPressureByStroke = new Map();
  const firstConsumedStrokeSeen = new Set();
  const firstDabPressureErrors = [];
  const emitterTransportLags = [];
  const ingressConsumeLags = [];
  let nativePumpConsumeCount = 0;
  let spacePanDrawLeakCount = 0;
  let nativeEmptyWithContactCount = 0;
  let nativeConsumeCount = 0;
  let latestV3Diagnostics = null;

  let parsedRows = 0;
  let skippedRows = 0;

  for (const line of lines) {
    const row = safeParseLine(line);
    if (!row) {
      skippedRows += 1;
      continue;
    }
    parsedRows += 1;

    const scope = typeof row.scope === 'string' ? row.scope : '(no-scope)';
    inc(scopeCounts, scope);

    if (scope.startsWith('frontend.anomaly.') || scope === 'frontend.canvas.queue_drop') {
      inc(anomalyCounts, scope);
    }
    if (scope === 'frontend.anomaly.space_pan_draw_leak') {
      const count = Number(row.count);
      spacePanDrawLeakCount += Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
    }

    if (row.v3_diagnostics && typeof row.v3_diagnostics === 'object') {
      latestV3Diagnostics = row.v3_diagnostics;
    }
    if (scope === 'frontend.pointerdown.native_seed') {
      const strokeId = Number(row.stroke_id);
      const pressure = Number(row.pressure_0_1);
      if (Number.isFinite(strokeId) && Number.isFinite(pressure) && !firstSeedPressureByStroke.has(strokeId)) {
        firstSeedPressureByStroke.set(strokeId, pressure);
      }
    }
    if (scope === 'frontend.pointermove.native_empty' && row.pointer_contact) {
      nativeEmptyWithContactCount += 1;
    }
    if (PRIMARY_NATIVE_CONSUME_SCOPES.has(scope)) {
      const lagMs = getMsLag(row.trace_epoch_ms, row.host_time_us);
      if (lagMs !== null) {
        ingressConsumeLags.push(lagMs);
      }
      nativeConsumeCount += 1;
      if (scope === 'frontend.native_pump.consume') {
        nativePumpConsumeCount += 1;
      }
      const strokeId = Number(row.stroke_id);
      if (Number.isFinite(strokeId) && !firstConsumedStrokeSeen.has(strokeId)) {
        firstConsumedStrokeSeen.add(strokeId);
        const seedPressure = firstSeedPressureByStroke.get(strokeId);
        const consumePressure = Number(row.pressure_0_1);
        if (Number.isFinite(seedPressure) && Number.isFinite(consumePressure)) {
          firstDabPressureErrors.push(Math.abs(consumePressure - seedPressure));
        }
      }
    }
    if (scope === 'frontend.recv.emitter_batch_v1') {
      const traceEpochMs = Number(row.trace_epoch_ms);
      const emitCompletedUs = Number(row.emit_completed_time_us);
      if (Number.isFinite(traceEpochMs) && Number.isFinite(emitCompletedUs)) {
        emitterTransportLags.push(traceEpochMs - emitCompletedUs / 1000);
      }
    }

    const counter = getStrokeCounter(strokeCounters, row.stroke_id);
    if (!counter) continue;
    updateStrokeTime(counter, row);

    switch (scope) {
      case 'frontend.recv.native_v3':
        counter.recvNative += 1;
        break;
      case 'frontend.pointerdown.dom':
        counter.domDown += 1;
        break;
      case 'frontend.pointermove.dom':
        counter.domMove += 1;
        break;
      case 'frontend.pointerup.dom':
        counter.domUp += 1;
        break;
      case 'frontend.pointermove.native_consume':
      case 'frontend.pointerup.native_consume':
      case 'frontend.ingress.native_tick_consume':
        counter.nativeConsume += 1;
        break;
      case 'frontend.native_pump.stroke_start':
        counter.nativePumpStart += 1;
        break;
      case 'frontend.native_pump.consume':
        counter.nativePumpConsume += 1;
        counter.nativeConsume += 1;
        break;
      case 'frontend.canvas.consume_point':
        counter.canvasConsume += 1;
        break;
      case 'frontend.canvas.consume_tail_point':
        counter.canvasTailConsume += 1;
        break;
      default:
        break;
    }
  }

  console.log(`[Trace] file=${args.file}`);
  console.log(`[Trace] lines_scanned=${lines.length} parsed_rows=${parsedRows} skipped_rows=${skippedRows}`);
  printScopeTop(scopeCounts, 24);
  console.log('');
  printStrokeSummary(strokeCounters);
  console.log('');
  printSuspiciousStrokes(strokeCounters);
  console.log('');
  const strokeSummaryNativeConsumeTotal = [...strokeCounters.values()].reduce(
    (sum, counter) => sum + counter.nativeConsume,
    0
  );
  console.log('[Trace] scope consistency check:');
  console.log(`  consume_scopes_total=${nativeConsumeCount}`);
  console.log(`  stroke_summary_native_consume_total=${strokeSummaryNativeConsumeTotal}`);
  if (strokeSummaryNativeConsumeTotal !== nativeConsumeCount) {
    console.log(
      `  [Warning] mismatch=${nativeConsumeCount - strokeSummaryNativeConsumeTotal} (summary likely missing scope mapping)`
    );
  } else {
    console.log('  status=ok');
  }
  console.log('');
  console.log('[Trace] anomaly counts:');
  if (anomalyCounts.size === 0) {
    console.log('  (none)');
  } else {
    for (const [scope, count] of [...anomalyCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${scope}: ${count}`);
    }
  }
  const nativeEmptyDenominator = nativeConsumeCount + nativeEmptyWithContactCount;
  const nativeEmptyWithContactRate =
    nativeEmptyDenominator > 0 ? nativeEmptyWithContactCount / nativeEmptyDenominator : null;
  const firstDabPressureErrorSorted = [...firstDabPressureErrors].sort((a, b) => a - b);
  const firstDabPressureErrorP95 = quantile(firstDabPressureErrorSorted, 0.95);
  const emitTransportSorted = [...emitterTransportLags].sort((a, b) => a - b);
  const emitToFrontendRecvP95Ms = quantile(emitTransportSorted, 0.95);
  const ingressConsumeSorted = [...ingressConsumeLags].sort((a, b) => a - b);
  const hostToIngressConsumeP95Ms = quantile(ingressConsumeSorted, 0.95);
  const nativePumpPrimaryConsumeRate =
    nativeConsumeCount > 0 ? nativePumpConsumeCount / nativeConsumeCount : null;
  const pressureClampRate =
    latestV3Diagnostics &&
    Number.isFinite(latestV3Diagnostics.pressure_total_count) &&
    latestV3Diagnostics.pressure_total_count > 0 &&
    Number.isFinite(latestV3Diagnostics.pressure_clamp_count)
      ? latestV3Diagnostics.pressure_clamp_count / latestV3Diagnostics.pressure_total_count
      : null;

  console.log('');
  console.log('[Blocking] metrics:');
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
}

main();
