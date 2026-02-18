# Dual Brush Size 按比例缩放实现方案

## 背景

用户观察到 Photoshop 中 Dual Brush Size 的行为：
- UI 显示的是绝对像素值
- 但当主笔刷缩放时，Dual Brush Size 会按比例缩放

经过对 `liuyang_paintbrushes.abr` 的分析，确认 ABR 文件存储的是**绝对值** (`Dmtr` 字段，单位 `#Pxl`)。PS 的运行时行为是：
1. 导入预设时，根据当时的主/副笔刷尺寸计算比例
2. 用户缩放主笔刷时，Dual Brush Size = 主 Size × 保存的比例

## 方案选择

**方案 A：完全模拟 PS 行为** ✅ 用户已选择

---

## 改动概览

### 数据结构

#### [MODIFY] [types.rs](file:///f:/CodeProjects/PaintBoard/src-tauri/src/abr/types.rs)
- `DualBrushSettings` 新增 `size_ratio: f32` 字段 (Dual Size / 保存时的主 Size)

#### [MODIFY] [tool.ts](file:///f:/CodeProjects/PaintBoard/src/stores/tool.ts)
- `DualBrushSettings` 接口新增 `sizeRatio: number` (0-10 范围)
- 修改 `setDualBrush` 逻辑，在设置 `size` 时自动计算 `sizeRatio`
- 新增 `updateDualBrushSizeFromRatio()` 方法：当主笔刷尺寸变化时调用

---

### ABR 导入

#### [MODIFY] [parser.rs](file:///f:/CodeProjects/PaintBoard/src-tauri/src/abr/parser.rs)
- `parse_dual_brush_settings()` 中计算 `size_ratio = dual_size / main_size`

---

### 运行时逻辑

#### [MODIFY] [useBrushRenderer.ts](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/useBrushRenderer.ts)
- 第 382-442 行的 Dual Brush 渲染逻辑：直接使用 `dualBrush.size` (已由 store 维护正确值)
- 无需再手动计算 `scaleFactor * dualBrush.size`，因为 store 会自动同步

#### [MODIFY] [DualBrushSettings.tsx](file:///f:/CodeProjects/PaintBoard/src/components/BrushPanel/settings/DualBrushSettings.tsx)
- Size 滑动条：值变化时调用 `setDualBrush({ size, sizeRatio: newSize / currentMainSize })`
- **显示格式改为**: `50px (32%)` — 同时展示绝对值和相对主笔刷的比例
- 计算方式: `ratio = Math.round(dualBrush.sizeRatio * 100)`

---

### Store 同步

#### [MODIFY] [tool.ts](file:///f:/CodeProjects/PaintBoard/src/stores/tool.ts)
在 `setBrushSize` 中添加逻辑：
```typescript
setBrushSize: (size) => {
  const clamped = clamp(size, 1, 1000);
  set((state) => {
    // 当主笔刷尺寸变化时，按比例更新 Dual Brush Size
    const newDualSize = clamped * state.dualBrush.sizeRatio;
    return {
      brushSize: clamped,
      dualBrush: {
        ...state.dualBrush,
        size: clamp(newDualSize, 1, 1000),
      },
    };
  });
},
```

---

## 验证计划

### 单元测试

运行命令：`pnpm test:unit`

#### 新增测试用例 (在 `src/stores/__tests__/tool.test.ts`):

```typescript
describe('Dual Brush Size Ratio', () => {
  it('should update dual brush size when main brush size changes', () => {
    const store = useToolStore.getState();
    
    // Set up: main size = 100, dual size = 50 (ratio = 0.5)
    store.setBrushSize(100);
    store.setDualBrush({ size: 50, sizeRatio: 0.5 });
    
    // Act: change main size to 200
    store.setBrushSize(200);
    
    // Assert: dual size should be 100 (200 * 0.5)
    expect(useToolStore.getState().dualBrush.size).toBe(100);
  });

  it('should update sizeRatio when dual size is changed directly', () => {
    const store = useToolStore.getState();
    
    store.setBrushSize(100);
    store.setDualBrush({ size: 150 });
    
    expect(useToolStore.getState().dualBrush.sizeRatio).toBe(1.5);
  });
});
```

### 手动测试

1. **导入 ABR 并检查初始比例**
   - 导入 `abr/liuyang_paintbrushes.abr`
   - 选择一个启用 Dual Brush 的预设 (如 "喷枪 纹理4")
   - 记录主笔刷尺寸 (394px) 和 Dual Brush Size (595px)
   - 验证 `sizeRatio ≈ 1.51`

2. **缩放主笔刷验证 Dual Size 同步**
   - 将主笔刷调整为 200px
   - 验证 Dual Brush Size 自动变为 ≈ 302px (200 × 1.51)
   - UI 滑动条位置应同步更新

3. **直接调整 Dual Size 验证比例更新**
   - 手动将 Dual Size 改为 100px
   - 主笔刷尺寸不变
   - 验证 sizeRatio 更新为 100 / 当前主尺寸

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 比例精度丢失 | 中 | 使用 f64 计算，保留 4 位小数 |
| ABR 导入时主尺寸为 0 | 低 | 默认 ratio = 1.0，使用 clamp 保护 |
| 性能 (setBrushSize 频繁调用) | 低 | 计算简单，不涉及 I/O |

## 置信度

**85%** - 方案清晰，改动范围可控。主要不确定性在于：
- ABR 导入时需要确认 "保存时的主尺寸" 来自哪个字段（需要验证 `Brsh.Dmtr` 是否就是主尺寸）
