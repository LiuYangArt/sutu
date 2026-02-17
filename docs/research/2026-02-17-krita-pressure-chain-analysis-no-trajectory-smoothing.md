# Krita 压感方案与执行链路分析（排除轨迹平滑）

**日期**：2026-02-17  
**范围**：仅分析 Krita 压感相关执行链路 + Tablet 设置中红框参数。  
**明确排除**：Tool Options 的轨迹平滑（`NONE/BASIC/WEIGHTED/STABILIZER/PIXEL`）实现与调参。

---

## 1. 先说结论

1. Krita 的压感主链路是：`输入事件 -> KoPointerEvent -> KisPaintingInformationBuilder -> KisPaintInformation -> paintLine 采样插值 -> paintop 传感器`。  
2. 红框里真正直接改“压感值映射”的只有 **Input Pressure Global Curve**。  
3. `Maximum brush speed / Brush speed smoothing / Use tablet driver timestamps for brush speed` 作用于 **速度估计**，它们会影响 `Speed` 传感器输入，不会直接改原始 pressure。  
4. `Use mouse events for right- and middle-clicks` 是输入路由 workaround，不直接改 pressure 数值。  
5. 轨迹平滑（Tool Options 的 Brush Smoothing）不在本文范围，且与本链路分离。
6. 针对当前 PaintBoard “压感尖尾” issue，speed 参数可先冻结隔离；在画笔未启用 `Speed` 传感器时，不应把 speed slider 作为尖尾差异主因。

---

## 2. 执行链路（不含轨迹平滑）

### 2.1 输入事件进入统一指针事件

1. Qt 侧 Tablet/Mouse/Touch 事件统一封装为 `KoPointerEvent`。  
   - `F:\CodeProjects\krita\libs\flake\KoPointerEvent.h:125`（pressure 定义）  
   - `F:\CodeProjects\krita\libs\flake\KoPointerEvent.cpp:306`（`QTabletEvent::pressure()` 读取）  
   - `F:\CodeProjects\krita\libs\flake\KoPointerEvent.cpp:405`（时间戳 `event->timestamp()`）
2. 输入管理器对事件做过滤与路由，再交给工具层。  
   - `F:\CodeProjects\krita\libs\ui\input\kis_input_manager.cpp:628`（`TabletPress`）  
   - `F:\CodeProjects\krita\libs\ui\input\kis_input_manager.cpp:665`（`TabletMove`）  
   - `F:\CodeProjects\krita\libs\ui\input\kis_input_manager.cpp:692`（`TabletRelease`）

### 2.2 Tool 层构建 `KisPaintInformation`

1. Freehand helper 在起笔/续笔时调用 builder。  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:259`（`startStroke`）  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:464`（`continueStroke`）
2. Builder 读取配置并缓存：
   - 全局压感曲线：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:47`  
   - 最大速度阈值：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:49`  
   - 速度平滑器配置刷新：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:58`
3. 生成 `KisPaintInformation` 时：
   - 读取速度估计：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:128`  
   - pressure 进入构造：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:131`  
   - speed 归一化到 `[0,1]`：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:137`
4. 全局压感曲线映射执行点：
   - `F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:179`（`pressureToCurve`）  
   - `F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:181`（`KisCubicCurve::interpolateLinear`）

### 2.3 线段采样、插值、出 dab

1. Tool 侧提交 `paintLine` job。  
   - `F:\CodeProjects\krita\libs\ui\tool\strokes\freehand_stroke.cpp:170`  
   - `F:\CodeProjects\krita\libs\ui\tool\strokes\KisMaskedFreehandStrokePainter.cpp:45`
2. `KisPainter` 转调 paintop。  
   - `F:\CodeProjects\krita\libs\image\kis_painter.cc:1151`  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop.cc:139`
3. 核心采样循环在 `KisPaintOpUtils::paintLine()`：
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:67`（`getNextPointPosition`）  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:68`（`KisPaintInformation::mix`）  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paintop_utils.h:84`（`paintAt`）
4. `mix()` 中 pressure/time/speed 是线性插值：
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paint_information.cc:619`（pressure）  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paint_information.cc:635`（time）  
   - `F:\CodeProjects\krita\libs\image\brushengine\kis_paint_information.cc:636`（speed）
5. 采样触发语义（distance/timing）由 `KisDistanceInformation` 决定：
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:405`  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:424`  
   - `F:\CodeProjects\krita\libs\image\kis_distance_information.cpp:431`

### 2.4 传感器消费（pressure/speed 等）

1. `KisCurveOption` 汇总激活的动态传感器并取值。  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\KisCurveOption.cpp:40`（Pressure 传感器）  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\KisCurveOption.cpp:51`（Speed 传感器）  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\KisCurveOption.cpp:111`（`s->parameter(info)`）
2. 传感器公共曲线映射入口：
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensor.cpp:35`  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensor.cpp:43`
3. Pressure / Speed 传感器原始值来源：
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensors.h:43`（`info.pressure()`）  
   - `F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensors.h:20`（`info.drawingSpeed()`）

---

## 3. 红框参数逐项说明（功能 + 实现）

### 3.1 Input Pressure Global Curve

**功能**：把输入 pressure（0~1）映射到新的 pressure（0~1），作为全局压感手感校准。  
**UI**：
- `F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:28`（组标题）
- `F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:32`（`pressureCurve` 控件）

**配置读写**：
- 读取并显示：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1645`  
- 保存：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:2854`  
- 配置键：`tabletPressureCurve`  
  - 读取：`F:\CodeProjects\krita\libs\ui\kis_config.cc:1584`  
  - 写入：`F:\CodeProjects\krita\libs\ui\kis_config.cc:1601`

**运行时实现**：
- 字符串曲线解析：`F:\CodeProjects\krita\libs\image\kis_cubic_curve.cpp:190`  
- 预采样传递表：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:48`  
- 线性查询映射：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:181`，实现见 `F:\CodeProjects\krita\libs\image\kis_cubic_curve.cpp:400`

### 3.2 Use mouse events for right- and middle-clicks

**功能**：一些设备/驱动不会从 tablet 事件流给出笔侧键，开启后改为从 mouse 事件流读取右/中键。  
**UI**：`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:175`、`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:180`

**配置读写**：
- 读取并显示：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1649`  
- 保存：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:2855`  
- 配置键：`useRightMiddleTabletButtonWorkaround`  
  - 读取：`F:\CodeProjects\krita\libs\ui\kis_config.cc:1646`  
  - 写入：`F:\CodeProjects\krita\libs\ui\kis_config.cc:1651`

**运行时实现**：
- EventEater 启动时读取开关：`F:\CodeProjects\krita\libs\ui\input\kis_input_manager_p.cpp:72`  
- 开启后：拦截非左键 tablet press/release：`F:\CodeProjects\krita\libs\ui\input\kis_input_manager_p.cpp:111`、`F:\CodeProjects\krita\libs\ui\input\kis_input_manager_p.cpp:116`  
- 同时允许非左键 mouse button 事件通过：`F:\CodeProjects\krita\libs\ui\input\kis_input_manager_p.cpp:120`、`F:\CodeProjects\krita\libs\ui\input\kis_input_manager_p.cpp:126`

**对压感链路影响**：不改变 pressure 数值，只影响侧键事件从哪条事件流进入。

### 3.3 Use tablet driver timestamps for brush speed

**功能**：速度估计时，时间轴用 tablet 驱动时间戳，而不是本地 `QElapsedTimer`。  
**UI**：
- 控件：`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:185`  
- Windows 警示文案：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1673`

**配置读写**：
- 读取并显示：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1677`  
- 保存：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:2869`  
- 配置键：`useTimestampsForBrushSpeed`

**运行时实现**：
- 读取开关：`F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:103`  
- 时间源分支：`F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:83` 到 `F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:85`

**对压感链路影响**：不直接改 pressure；会改变 `drawingSpeed`，从而影响所有依赖 Speed 传感器的画笔动态。

### 3.4 Maximum brush speed: N px/ms

**功能**：把物理速度归一化到 `[0,1]` 的上限标定值。超过阈值被截断到 1。  
**UI**：
- 控件 + tooltip：`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:206`、`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:214`  
- 范围与文案：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1692`、`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1698`

**配置读写**：
- 读取并显示：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1693`  
- 保存：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:2881`  
- 配置键：`maxAllowedSpeedValue`

**运行时实现**：
- builder 读取：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:49`  
- 归一化：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:137`

### 3.5 Brush speed smoothing: N samples

**功能**：速度估计的平滑窗口强度。值越大，速度信号越稳但响应更慢。  
**UI**：
- 控件 + tooltip：`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:219`、`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:227`  
- 范围与文案：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1701`、`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1707`

**配置读写**：
- 读取并显示：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1702`  
- 保存：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:2882`  
- 配置键：`speedValueSmoothing`

**运行时实现**：
- 读取平滑样本数：`F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:104`  
- 速度累积与停止条件：`F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:149`、`F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:150`  
- 输出速度：`F:\CodeProjects\krita\libs\ui\tool\kis_speed_smoother.cpp:157`

---

## 4. 与红框强相关但容易混淆的点

### 4.1 速度设置是“速度传感器输入链路”，不是“压感曲线”

- `drawingSpeed` 由 builder 写入 `KisPaintInformation`：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:137`  
- `Speed` 传感器读取 `info.drawingSpeed()`：`F:\CodeProjects\krita\plugins\paintops\libpaintop\sensors\KisDynamicSensors.h:20`
- 最终是否影响笔迹，取决于该笔刷是否启用了 speed 相关 curve option（`KisCurveOption.cpp`）。

### 4.2 轨迹平滑不在这条链路里

- Tool 层 Brush Smoothing 分支在 `KisToolFreehandHelper::paint()`，例如：  
  - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:592`（Simple/Weighted）  
  - `F:\CodeProjects\krita\libs\ui\tool\kis_tool_freehand_helper.cpp:665`（Stabilizer）
- 本文刻意不展开这些分支，只保留压感/速度/采样链路。

### 4.3 `DisablePressure` 命名与实际语义在代码里有反直觉点

- 资源位定义：`F:\CodeProjects\krita\libs\resources\KoCanvasResourcesIds.h:58`  
- Action 文案是 “Use Pen Pressure”：`F:\CodeProjects\krita\krita\krita.action:614`、`F:\CodeProjects\krita\krita\krita.action:616`  
- Action 切换写入 `setDisablePressure(checked)`：`F:\CodeProjects\krita\libs\ui\kis_paintop_box.cc:1395`、`F:\CodeProjects\krita\libs\ui\kis_paintop_box.cc:1403`  
- builder 的 pressure 分支见：`F:\CodeProjects\krita\libs\ui\tool\kis_painting_information_builder.cpp:131`

这组命名在阅读上容易误判，做对齐脚本时建议直接以 `KisPaintInformation` 实际生成值为准。

### 4.4 当前尖尾 issue 的执行口径（建议）

1. **对齐优先级**：先压 `pressure_mapped / sampler_t / dab_emit`，speed 仅做观察字段。  
2. **测试前提**：使用未启用 `Speed` 传感器的笔刷 preset（避免把 speed 动态误当压感问题）。  
3. **实现策略**：像轨迹平滑一样，把 speed 启发式从主链路隔离，避免影响尖尾判定。当前分支已按此执行：  
   - `src/components/Canvas/useBrushRenderer.ts:215`  
   - `src/components/Canvas/useBrushRenderer.ts:818`  
   - `src/components/Canvas/useBrushRenderer.ts:862`
4. **何时重新纳入 speed**：只有在专项对齐“启用 Speed 传感器的 Krita 笔刷”时，再把 speed 相关参数恢复为 gate 维度。

---

## 5. （附）与 Tablet API 相关的实现锚点

虽然不在你截图红框内，但它决定输入事件源，实操调试时常需要一起看：

1. API 选择 UI（WinTab / Windows Ink）：`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:128`、`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:136`、`F:\CodeProjects\krita\libs\ui\forms\wdgtabletsettings.ui:165`  
2. Preferences 读写 + Qt6 运行时切换：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1661`、`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:2859`、`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:2865`  
3. 应用启动时设置 WinTab/WinInk：`F:\CodeProjects\krita\krita\main.cc:588`、`F:\CodeProjects\krita\krita\main.cc:605`、`F:\CodeProjects\krita\krita\main.cc:608`  
4. WinTab Advanced（映射）按钮入口：`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1664`、`F:\CodeProjects\krita\libs\ui\dialogs\kis_dlg_preferences.cc:1728`  
5. 映射通过环境变量生效：`F:\CodeProjects\krita\libs\ui\dialogs\KisDlgCustomTabletResolution.cpp:149`、`F:\CodeProjects\krita\libs\ui\dialogs\KisDlgCustomTabletResolution.cpp:157`

---

## 6. 对 PaintBoard 做压感对齐时应优先复刻的 Krita 语义（不含轨迹平滑）

1. **全局压感曲线**：`KisCubicCurve` 预采样 + `interpolateLinear` 的映射方式。  
2. **速度估计链路**：时间源选择（driver timestamp vs local timer）+ smoothing samples + 最小跟踪距离阈值。  
3. **speed 归一化策略**：`speed / maxAllowedSpeedValue` 并 `qMin(1.0, ...)`。  
4. **采样插值语义**：`getNextPointPosition` + `KisPaintInformation::mix()` 的线性插值（pressure/time/speed）。  
5. **传感器消费语义**：`KisDynamicSensor::parameter()` 的传感器曲线映射。

这 5 项是“尖尾压感差异”最可能出现系统性偏差的核心链路。
