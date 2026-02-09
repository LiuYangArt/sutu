# Tablet Input V2 诊断报告模板

## 1. 基础信息
- 日期：
- 构建版本（commit/tag）：
- 操作系统：
- 设备型号（数位板/笔）：
- 驱动版本：

## 2. 输入配置快照
- Requested Backend：
- Active Backend：
- Fallback Reason：
- Backpressure Mode：`lossless` / `latency_capped`
- Polling Rate：
- Pressure Curve：

## 3. 队列指标（`queue_metrics`）
- `enqueued`：
- `dequeued`：
- `dropped`：
- `current_depth`：
- `max_depth`：
- `latency_p50_us`：
- `latency_p95_us`：
- `latency_p99_us`：
- `latency_last_us`：

## 4. 压感连续性（手工）
- 场景：20 笔轻压/重压/快慢交替
- 结果摘要：
- 断压次数：
- 固定压次数：
- 主观手感结论（起笔/行笔）：

## 5. 回退行为（手工）
- WinTab 初始化失败复现方式：
- 是否自动回退 PointerEvent：
- Toast 与状态文案是否明确：
- 回退后是否可继续稳定绘制：

## 6. Settings 滚动条 Pen 交互（手工）
- 场景：按住滚动条拖拽后离开滚动条区域
- 是否持续滚动直到 `pointerup/cancel`：
- 中断次数 / 总次数：
- 中断率：

## 7. 自动化结果
- `pnpm -s typecheck`：
- `pnpm -s test`：
- `cargo test --manifest-path src-tauri/Cargo.toml`：

## 8. 结论与后续动作
- 是否满足上线门槛：是 / 否
- 风险项：
- 建议动作：
