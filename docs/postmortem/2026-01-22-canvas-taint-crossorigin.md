# Canvas Taint (污染) 问题 - crossOrigin 缺失

## 日期
2026-01-22

## 问题描述

使用 `project://` 自定义协议加载图层图像后，Canvas 被标记为"被污染 (Tainted)"，导致后续操作失败。

### 症状
```
Uncaught SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D':
The canvas has been tainted by cross-origin data.
```

### 触发条件
- 打开一个 ORA 文件 → 正常
- 再打开另一个 ORA 文件 → 报错崩溃

### 影响
- `getImageData()` 失败
- `toDataURL()` 失败
- 导出功能失效
- 程序崩溃

## 根因分析

### 跨域安全机制

浏览器安全策略规定：如果 `<canvas>` 绘制了一张来自"不同源 (Origin)"的图片，Canvas 会被标记为"被污染"。

| 资源 | Origin |
|------|--------|
| 应用页面 | `http://localhost:1420` |
| 图层图片 | `http://project.localhost/layer/{id}` |

浏览器判定：**跨域行为** → Canvas 被污染 → 禁止读取像素数据

### 缺失的配置

要解决跨域问题，需要**双向配置**：

| 端 | 配置 | 状态 |
|----|------|------|
| 后端 (Rust) | `Access-Control-Allow-Origin: *` | ✅ 已有 |
| 前端 (TS) | `img.crossOrigin = 'anonymous'` | ❌ 缺失 |

后端虽然正确设置了 CORS header，但前端加载图片时没有声明 `crossOrigin`，浏览器默认不发送 CORS 请求。

## 修复方案

### 修改文件
`src/components/Canvas/index.tsx` (L408-409)

### 修改内容
```typescript
// Before
const img = new Image();
await new Promise<void>((resolve) => {
  img.onload = () => { ... };
  img.src = imgSrc;
});

// After
const img = new Image();
img.crossOrigin = 'anonymous'; // Required for cross-origin protocol (project://)
await new Promise<void>((resolve) => {
  img.onload = () => { ... };
  img.src = imgSrc;
});
```

**关键**：`crossOrigin` 必须在设置 `src` **之前**设置。

## 经验教训

### 1. CORS 需要双向配置
- 服务端设置 `Access-Control-Allow-Origin` 只是一半
- 客户端必须用 `crossOrigin` 属性声明"我要跨域请求"

### 2. 自定义协议 = 跨域
- Tauri 的 `project://` 协议在 Windows 上映射为 `http://project.localhost/`
- 与主应用 `http://localhost:1420` 属于不同 Origin
- 所有涉及 Canvas 的图片加载都需要 `crossOrigin`

### 3. 问题延迟显现
- 第一次打开文件可能不触发（取决于操作顺序）
- 当执行 `getImageData` 或 `toDataURL` 时才报错
- 难以复现 → 需要完整的文件打开/关闭/再打开流程测试

## 验证步骤

1. `pnpm dev` 启动开发服务器
2. 打开一个 ORA 文件
3. 再打开另一个 ORA 文件
4. 确认无 SecurityError
5. 测试导出功能（File > Export）

## 相关文件

- `src/components/Canvas/index.tsx` - 前端图层加载 (修复位置)
- `src-tauri/src/lib.rs` - 后端 CORS header 设置
- `docs/design/file-io-optimization.md` - 自定义协议设计文档

## 相关问题

- `custom-protocol-cache-miss.md` - Cache MISS 问题（同一功能的另一个 bug）
