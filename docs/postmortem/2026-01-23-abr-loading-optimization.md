# ABR 笔刷加载优化 - 零编码 + LZ4 压缩

## 日期
2026-01-23

## 问题描述

ABR 笔刷导入性能差，用户体验卡顿。

### 旧方案瓶颈
```
Disk → Parse → PNG Encode → Base64 → JSON IPC → JS Decode → Display
                  ↑            ↑           ↑
               慢 (CPU)    膨胀 33%    大 payload
```

### 优化目标
1. 零编码 (Zero-Encoding)：移除 PNG/Base64
2. 流式反馈：通过 `project://` 协议按需加载
3. Benchmark 日志：输出加载耗时

## 解决方案

### 架构改造

**新数据流**：
```
Disk → Parse → LZ4 Compress → BrushCache (Memory + Disk)
                                    ↓
Frontend ← http://project.localhost/brush/{id} ← LZ4 Response
```

### 关键修改

| 文件 | 修改内容 |
|------|----------|
| `src-tauri/Cargo.toml` | 添加 `dirs = "5"` 依赖 |
| `src-tauri/src/brush/cache.rs` | **新建** 两级缓存：内存 + 磁盘持久化 |
| `src-tauri/src/brush/mod.rs` | 导出 cache 模块 |
| `src-tauri/src/lib.rs` | 添加 `/brush/{id}` 协议路由 + `build_gray_lz4_response` |
| `src-tauri/src/abr/types.rs` | 移除 `texture_data` 字段和 `encode_texture` 函数 |
| `src-tauri/src/commands.rs` | 重写 `import_abr_file` + benchmark |
| `src/components/BrushPanel/BrushThumbnail.tsx` | **新建** Canvas 渲染 LZ4 压缩纹理 |
| `src/components/BrushPanel/settings/BrushPresets.tsx` | 使用新数据流 |
| `src/components/BrushPanel/types.ts` | 添加 `ImportAbrResult` 类型 |
| `src/gpu/resources/TextureAtlas.ts` | 添加 `loadTextureFromProtocol` 方法 |
| `src/utils/textureMaskCache.ts` | 添加 `loadTextureFromProtocol` 方法 |

## 遇到的问题

### 问题 1: Brush cache MISS

**症状**：后端日志显示 `Brush cache MISS: {id}`，缩略图不显示

**根因**：笔刷缓存是纯内存结构，开发时热重载或应用重启后内存被清空

**修复**：添加磁盘持久化机制（两级缓存）
- 存储路径：`AppData/com.paintboard/brush_cache/{id}.bin`
- 格式：`width(4) + height(4) + name_len(4) + name + lz4_data`

### 问题 2: Failed to fetch

**症状**：前端 `fetch('project://brush/{id}')` 返回 `TypeError: Failed to fetch`

**根因**：Windows 上 Tauri 自定义协议的 URL 格式错误

**修复**：使用 `http://project.localhost/...` 格式

```typescript
// ❌ 错误
fetch('project://brush/${id}')

// ✅ 正确
fetch('http://project.localhost/brush/${id}')
```

**参考**：`docs/postmortem/2026-01-22-canvas-taint-crossorigin.md`

### 问题 3: 纹理笔刷画不出东西

**症状**：缩略图正常显示，但选中笔刷后绘画无效果

**根因**：GPU/CPU 渲染引擎使用 `texture.data` (Base64) 获取纹理，但优化后 `data` 为空

**修复**：
1. `TextureAtlas.ts` - 添加 `loadTextureFromProtocol` 方法
2. `textureMaskCache.ts` - 添加 `loadTextureFromProtocol` 方法
3. 加载顺序：先尝试协议加载，失败则降级到 Base64

## 经验教训

### 1. 自定义协议 URL 格式
- Windows 上 `project://` 映射为 `http://project.localhost/`
- 必须使用后者进行 `fetch` 请求

### 2. 缓存需要持久化
- 纯内存缓存在热重载/重启后丢失
- 应实现两级缓存：内存（快）+ 磁盘（持久）

### 3. 渲染引擎适配
- 修改数据格式后，所有使用该数据的模块都需要适配
- GPU 渲染 (`TextureAtlas`) 和 CPU 渲染 (`textureMaskCache`) 都需要更新

### 4. 查阅 postmortem 文档
- 项目历史经验非常有价值
- `custom-protocol-cache-miss.md` 和 `canvas-taint-crossorigin.md` 提供了关键线索

## 预期收益

- **IPC Payload**：减少 90%+（移除 Base64 字符串）
- **加载速度**：提升 10x（并行处理 + 零编码）
- **用户体验**：流式加载，无卡顿

## Benchmark 日志格式

```
// 后端 (Rust tracing)
[ABR Benchmark] Loaded 42 brushes in 156.32ms (read: 5.21ms, parse: 89.21ms, cache: 67.11ms)
[ABR Benchmark] Texture data: 12500 KB raw -> 4200 KB compressed (33.6%)

// 前端 (console.log)
[ABR Import] Frontend received 42 brushes in 12.45ms
[ABR Import] Backend benchmark: { totalMs: 156.32, ... }
```

## 验证步骤

1. `pnpm dev` 启动开发服务器
2. 导入 ABR 文件，确认缩略图显示
3. 切换 GPU/CPU 渲染模式，确认纹理笔刷可用
4. 重启应用，确认缩略图仍然显示
5. 查看 Console，确认只有总体加载时间日志

## 相关文件

- `docs/design/abr-loading-optimization.md` - 设计文档
- `docs/postmortem/2026-01-22-canvas-taint-crossorigin.md` - 跨域问题
- `docs/postmortem/custom-protocol-cache-miss.md` - Cache MISS 问题
