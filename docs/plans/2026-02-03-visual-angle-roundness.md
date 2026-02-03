# 实施计划 - 可视化角度/圆度控件 (Angle/Roundness Widget)

**目标**: 在笔刷设置（BrushTipShape）中添加类似 Photoshop 的可视化控件，用于直观调整笔刷的角度（Angle）和圆度（Roundness）。

**方案**: 采用**增量式（方案B）**，即保留原有的滑动条，同时在右侧增加可视化圆盘控件。

## 核心变更

### 1. 新组件: `AngleRoundnessWidget`

创建位置: `src/components/BrushPanel/settings/AngleRoundnessWidget.tsx`

**UI 设计**:

- **SVG 画布**: 100x100px（支持响应式缩放）。
- **视觉元素**:
  - **外圈 (Outer Circle)**: 静态参考圆环。
  - **中心十字 (Crosshair)**: 指示轴向，随角度旋转。
  - **笔刷形状 (Brush Shape)**: 一个椭圆，根据当前的 `angle` 和 `roundness` 实时渲染。
  - **控制手柄 (Handles)**: 位于椭圆短轴两端的圆点，用于拖拽调整圆度。
  - **方向指示 (Direction Indicator)**: 位于长轴一端的箭头，指示当前角度。

**交互逻辑**:

- **调整圆度 (Roundness)**:
  - 判定：鼠标按下位置靠近“控制手柄”。
  - 行为：限制在短轴方向移动，距离中心越近，圆度越小（椭圆越扁）。
  - 范围：1% - 100%。
- **调整角度 (Angle)**:
  - 判定：鼠标按下位置在控件区域内，但未击中控制手柄。
  - 行为：计算鼠标位置相对于中心的角度 (`Math.atan2`)。
  - 范围：0° - 360°。

### 2. 集成: `BrushTipShape.tsx`

修改文件: `src/components/BrushPanel/settings/BrushTipShape.tsx`

**布局调整**:

- 引入 Flex 布局容器。
- **左侧**: 保留原有的 `Roundness` 和 `Angle` SliderRow 组件。
- **右侧**: 放置新的 `AngleRoundnessWidget`。
- **样式适配**: 可能需要微调 CSS 以确保两列布局在面板中显示美观且不拥挤。

## 验证计划

### 手动验证

1.  **交互测试**:
    - 拖拽圆盘的“空白/箭头区域” -> 验证角度滑块数值变化，笔刷预览旋转。
    - 拖拽圆盘的“控制点” -> 验证圆度滑块数值变化，笔刷形状变扁/圆。
    - 拖拽左侧滑块 -> 验证右侧圆盘控件实时跟随更新。
2.  **边界测试**:
    - 角度跨越 0°/360° 时的平滑度。
    - 圆度在 1% (最扁) 和 100% (正圆) 时的表现。
