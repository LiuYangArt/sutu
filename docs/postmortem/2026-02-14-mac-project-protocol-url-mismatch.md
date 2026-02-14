# macOS `project` 协议 URL 失配导致纹理/图层加载失败

## 日期
2026-02-14

## 问题描述

在 #128 中，用户反馈「Windows 正常，macOS 导入 ABR 后纹理笔刷缩略图不显示、无法出笔」。
控制台反复出现：

```text
[BrushLoader] Protocol load failed for <id>: TypeError: Load failed
Failed to load resource: Could not connect to the server
```

排查后发现不仅笔刷链路受影响，PSD/ORA 图层加载链路也存在同类风险。

## 影响范围

- ABR 纹理笔刷加载（缩略图 + 绘制）
- Pattern 纹理加载（缩略图/贴图读取）
- PSD/ORA 打开时的图层二进制拉取（`__loadLayerImages` 协议分支）

## 根因分析

前端多个模块硬编码了：

```text
http://project.localhost/<path>
```

这个地址在 Windows 可用，但在 macOS/Linux 下 Tauri 自定义协议通常走：

```text
project://localhost/<path>
```

因此在 macOS 上会出现协议连接失败。  
根因本质：协议 URL 构造分散且平台规则被硬编码，缺少统一适配入口。

## 修复方案

### 1) 引入统一 URL 构造工具

新增 `src/utils/projectProtocolUrl.ts`：

- `getProjectProtocolBaseUrl()`
- `buildProjectProtocolUrl(path)`

策略：
- 优先使用 `window.__TAURI_INTERNALS__.convertFileSrc('', 'project')` 获取平台真实映射；
- 非 Tauri/异常场景回退 `http://project.localhost`，保证测试环境和兼容性。

### 2) 全链路替换硬编码地址

- `src/utils/brushLoader.ts` (`/brush/{id}`)
- `src/components/Canvas/useGlobalExports.ts` (`/layer/{id}`)
- `src/utils/patternManager.ts` (`/pattern/{id}`)
- `src/stores/pattern.ts` (`/pattern/{id}?thumb=...`)

### 3) 补齐回归测试

- 新增 `src/utils/projectProtocolUrl.test.ts`
- 更新 `src/utils/brushLoader.test.ts`
- 更新 `src/stores/pattern.test.ts`
- 更新 `src/components/Canvas/__tests__/useGlobalExports.test.ts`
- 完善 `tests/features/mac-texture-brush-load.feature.ts`

覆盖点包含：Windows/macOS 映射、fallback、layer 协议分支。

## 验证结果

已通过：

```bash
pnpm -s vitest run src/utils/projectProtocolUrl.test.ts \
  src/utils/brushLoader.test.ts \
  src/stores/pattern.test.ts \
  src/components/Canvas/__tests__/useGlobalExports.test.ts

pnpm -s vitest run tests/features/mac-texture-brush-load.feature.ts
pnpm -s typecheck
```

## 经验教训

1. 自定义协议 URL 不能按单平台经验硬编码。  
2. 协议映射应统一入口，避免 brush/layer/pattern 各自实现。  
3. 回归测试必须包含跨平台映射断言，不只验证业务逻辑。  
4. 设计文档中「Windows workaround」应明确标注适用边界，避免被误用为全平台规则。

## 后续行动

- 将 `projectProtocolUrl` 作为 `project` 资源 URL 的唯一入口并在代码评审中强制检查。
- 后续若启用 `use_https_scheme`，仅需更新统一构造器和对应测试，不再全仓散点修改。
