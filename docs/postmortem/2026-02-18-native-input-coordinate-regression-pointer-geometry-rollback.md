# Native 输入坐标回归复盘（Pointer 几何回归稳定语义）

**日期**：2026-02-18  
**范围**：WinTab / MacNative 输入几何链路

## 1. 现象

1. `pointerevent` 绘制正常。  
2. `wintab` 出现外射/乱飞。  
3. `macnative` 出现镜像或方向反转。

## 2. 根因

1. 在重构阶段把几何主坐标切换到了 native `x/y`。  
2. native 后端坐标语义未统一（单位/原点/轴方向未契约化）。  
3. 前端用启发式映射承担了后端坐标语义缺口，导致跨后端不稳定。

## 3. 修复策略（本轮）

采用“恢复稳定语义”而非继续推进 native 几何主路径：

1. `usePointerHandlers`：几何坐标统一使用 PointerEvent；native 仅用于 pressure/tilt/rotation/time/source。  
2. `useRawPointerInput`：raw 路径同样统一使用 PointerEvent 几何坐标。  
3. 保留现有 phase/队列时序处理，避免回退到早期收笔竞态问题。

## 4. 验证

1. `pnpm -s vitest run src/components/Canvas/__tests__/usePointerHandlers.nativeOffset.test.ts`  
2. `pnpm -s vitest run src/components/Canvas/__tests__/useRawPointerInput.test.ts`  
3. `pnpm -s vitest run src/components/Canvas/__tests__/inputUtils.test.ts`  
4. `pnpm -s typecheck`  
5. `cargo check --manifest-path src-tauri/Cargo.toml --lib`

上述命令均通过。

## 5. 经验

1. “坐标几何真值来源”必须先有跨后端契约，再切换主路径。  
2. 在契约未冻结前，优先保留已验证稳定的几何来源（PointerEvent），native 专注传感器字段。  
3. 先止血再重构，能显著降低输入链路回归成本。

