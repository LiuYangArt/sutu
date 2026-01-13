# 压感处理功能路线图

基于 Krita 压感处理机制分析（见 `docs/design/krita-pressure-handling.md`），整理 PaintBoard 剩余待实现功能。

---

## 已完成 ✅

### 第一笔问题修复

| 功能 | 状态 | 说明 |
|------|------|------|
| PressureSmoother | ✅ 完成 | 滑动窗口平均，Krita 风格第一值初始化 |
| 前端延迟启动 | ✅ 完成 | BrushStamper 等待移动 3 像素 |
| 接受 pressure=0 | ✅ 完成 | inputUtils 不再跳过零压感点 |

**参考文档**: `docs/design/first-stroke-pressure-fix.md`

---

## 中期目标 🔧

### 1. 压感配置 UI

**优先级**: 中

**当前状态**: 后端支持配置，但 UI 未暴露

**待实现**:
- [ ] TabletPanel 添加"压感平滑"开关
- [ ] 滑动窗口大小可调（1-5）
- [ ] 设置持久化到 localStorage

**参考 Krita**:
- 设置路径: Settings → Configure Krita → Tablet Settings
- 平滑选项: "Smoothing" checkbox

**涉及文件**:
```
src/components/TabletPanel.tsx  - UI 控件
src/stores/tablet.ts            - 状态管理
src-tauri/src/commands.rs       - 后端配置传递
```

---

### 2. 速度感知笔刷

**优先级**: 中

**当前状态**: 未实现

**待实现**:
- [ ] 实现 `SpeedSmoother` 结构体
  - 参考 Krita `KisSpeedSmoother`
  - 第一个点速度返回 0
  - 历史距离累积计算
- [ ] 添加速度到 `RawInputPoint` 结构
- [ ] 笔刷引擎支持速度参数
- [ ] UI 添加"速度影响大小/透明度"选项

**Krita 关键代码参考**:
```cpp
// kis_speed_smoother.cpp:111-116
if (m_d->lastPoint.isNull()) {
    m_d->lastPoint = pt;
    m_d->lastTime = time;
    m_d->lastSpeed = 0.0;  // 第一个点速度为 0
    return 0.0;
}
```

**涉及文件**:
```
src-tauri/src/input/processor.rs  - SpeedSmoother 实现
src-tauri/src/input/mod.rs        - RawInputPoint 扩展
src-tauri/src/brush/engine.rs     - 速度参数支持
src/stores/tool.ts                - 速度选项状态
src/components/BrushPanel.tsx     - UI 控件
```

---

## 长期目标 🎯

### 3. 自定义压感曲线编辑器

**优先级**: 低

**当前状态**: 只有预设曲线 (Linear/Soft/Hard/SCurve)

**待实现**:
- [ ] 曲线编辑器 UI 组件
  - 可视化曲线显示
  - 拖拽控制点
  - 预设曲线快速选择
- [ ] `CubicCurve` 结构体
  - 参考 Krita `KisCubicCurve`
  - 多控制点贝塞尔样条
  - 预计算查找表（1025 点）
- [ ] 曲线序列化/反序列化
  - 格式: `"0.0,0.0;0.5,0.3;1.0,1.0;"`

**Krita 关键代码参考**:
```cpp
// kis_cubic_curve.cpp:136-152
void KisCubicCurve::Data::updateTransfer(...) {
    qreal end = 1.0 / (size - 1);
    for (int i = 0; i < size; ++i) {
        (*transfer)[i] = value(i * end) * max;
    }
}
```

**涉及文件**:
```
src/components/CurveEditor.tsx         - 曲线编辑器 UI
src-tauri/src/input/curve.rs           - CubicCurve 实现
src/stores/tool.ts                     - 曲线状态管理
```

---

### 4. 过滤滚动平均

**优先级**: 低

**当前状态**: 未实现

**用途**: 过滤极端时间戳偏差，提高采样率估计精度

**待实现**:
- [ ] `FilteredRollingMean` 结构体
  - 滑动窗口（默认 200）
  - 有效比例（默认 0.8，即去掉 20% 极端值）
  - 部分排序找极值
- [ ] 集成到时间戳处理

**Krita 关键代码参考**:
```cpp
// KisFilteredRollingMean.cpp:59-76
// 排序后去掉最高和最低的极端值
std::partial_sort_copy(m_values.begin(), m_values.end(),
                       m_cutOffBuffer.begin(),
                       m_cutOffBuffer.begin() + cutMin);
sum -= std::accumulate(m_cutOffBuffer.begin(),
                       m_cutOffBuffer.begin() + cutMin, 0.0);
```

**涉及文件**:
```
src-tauri/src/input/filter.rs  - FilteredRollingMean 实现
src-tauri/src/commands.rs      - 时间戳处理集成
```

---

### 5. 压感测试/校准工具

**优先级**: 低

**当前状态**: 只有 Spike 测试

**待实现**:
- [ ] 压感测试画布
  - 实时显示原始压感 vs 平滑后压感
  - 压感曲线可视化
- [ ] 校准向导
  - 轻触/重压测试
  - 自动建议曲线参数

---

## 参考资源

| 资源 | 路径 |
|------|------|
| Krita 压感机制文档 | `docs/design/krita-pressure-handling.md` |
| 第一笔问题修复记录 | `docs/design/first-stroke-pressure-fix.md` |
| Krita 源码 | `F:\CodeProjects\krita` |

---

## 优先级排序建议

1. **压感配置 UI** - 用户可见，提升体验
2. **速度感知笔刷** - 专业绘画必备功能
3. **自定义曲线** - 高级用户需求
4. **过滤滚动平均** - 内部优化，用户无感知
5. **校准工具** - 可选增强
