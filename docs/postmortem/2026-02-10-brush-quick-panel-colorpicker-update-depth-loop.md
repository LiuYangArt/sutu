# Brush Quick Panel 调色盘拖拽触发 Maximum Update Depth（2026-02-10）

**日期**：2026-02-10  
**状态**：已修复

## 背景

用户反馈在画布右键打开 Brush Quick Panel 后，若屏幕上同时存在右侧 ColorPanel 与快捷面板调色盘，  
在 **快捷面板调色盘** 内执行“左键按住拖拽”会偶发触发：

`Warning: Maximum update depth exceeded`

同样操作在右侧 Layer 上方 ColorPanel 内不触发。

## 现象

1. 触发路径具有明显条件：`两个 color picker 同时可见 + 快捷面板内拖拽`。  
2. 右侧固定 ColorPanel 单独拖拽正常。  
3. 报错堆栈持续指向 `BrushQuickPanel` 的颜色更新回调附近。

## 根因

本次问题是“高频拖拽输入 + 双面板共享颜色状态”下的更新链放大：

1. 快捷面板调色盘拖拽过程中，颜色更新频率极高。  
2. 两个 color picker 都订阅同一个 `tool.brushColor`，导致一次写色会驱动两侧重渲染。  
3. 快捷面板在拖拽中存在同步写色路径，叠加 React 严格模式与事件频率后，形成更新风暴，最终触发深度保护警告。

## 修复方案

### 修复 1：`setBrushColor` 幂等化（Store 层）

对大小写无关相同颜色直接返回原 state，阻断“同值重复写入”。

涉及：`src/stores/tool.ts`

### 修复 2：统一颜色面板为“单向同步”

ColorPanel / BrushQuickPanel 都改为：

1. 本地 `hsva` 仅由 `brushColor -> hexToHsva` 同步。  
2. 拖拽回调只负责发起“写入 brushColor”，不再同时反向写本地状态链。

涉及：
- `src/components/ColorPanel/index.tsx`
- `src/components/Canvas/BrushQuickPanel.tsx`

### 修复 3：快捷面板写色节流到每帧一次

BrushQuickPanel 内改为 `requestAnimationFrame` 合并写色：

1. 拖拽事件先写入队列。  
2. 每帧 flush 一次最终颜色。  
3. flush 前再次做同值短路。

这一步直接降低了“拖拽期间同步 setState 深链”风险。

涉及：`src/components/Canvas/BrushQuickPanel.tsx`

### 修复 4：拖拽 Hook 限制左键触发

`usePointerDrag` 只响应 `button === 0`，避免右键路径干扰颜色拖拽状态机。

涉及：`src/hooks/usePointerDrag.ts`

## 验证

1. `pnpm -s vitest run src/stores/__tests__/tool.test.ts src/components/Canvas/__tests__/brushQuickPanelPosition.test.ts src/components/Canvas/__tests__/BrushQuickPanel.test.tsx`  
2. `pnpm -s typecheck`  
3. 手动验证：同时显示两个 color picker，在快捷面板中持续拖拽调色盘，不再出现 `Maximum update depth exceeded`。

## 经验沉淀

1. **共享状态的多面板编辑器必须默认幂等写入**：同值写回应在 store 层短路，而不是依赖组件层“尽量不写”。  
2. **高频输入优先做帧级合并**：拖拽、滚轮、pointermove 这类输入应避免逐事件同步写全局状态。  
3. **双向同步容易形成回路**：同一组件里“本地状态更新 + 全局状态更新 + 全局反向同步本地”必须拆成单向数据流。  
4. **复现场景要保留并发条件**：本问题只在“双 picker 并存”下稳定出现，单组件验证无法暴露该类问题。
