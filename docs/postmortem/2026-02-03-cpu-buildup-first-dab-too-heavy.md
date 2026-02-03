# Postmortem: CPU Build-up 起笔首 dab 过重（2026-02-03）

## 背景
目标是复刻 Photoshop 的 Brush「Build-up / Airbrush」体验：按住不动仍持续喷涂，同时保持现有的 opacity ceiling（指数趋近）语义。v1 仅在 CPU（Canvas2D / `backend === 'canvas2d'`）路径落地，作为后续 GPU 对齐的 ground truth。

相关设计文档：`docs/plans/2026-02-03-buildup-feature-design.md`

## 现象
- 开启 Build-up 后，纹理笔刷原地积累效果整体接近 PS，但：
  - 积累速度最初偏快（60Hz 级别会很快“糊死”）。
  - **笔触起始处出现明显“重/黑”的 blob**，在非常轻的压感起笔时更明显，看起来像压感没生效或被错误抬高。

## 根因分析（事实 & 推断）
### 1) 速率偏快（事实）
- 最初 build-up tick 采用接近 60Hz 的补点，导致原地 stamp 频率过高，视觉上比 PS 更快到达 opacity ceiling。

### 2) 起笔首 dab 过重（事实 + 高概率推断）
起笔阶段（`strokeState === 'starting'`）存在多个压力来源不可靠/不同步的窗口，导致“首个被处理的点”压力偏高，从而直接出一个很重的 dab：

- **PointerEvent 的 pen 默认压力陷阱**（事实）
  - 某些情况下 `PointerEvent.pressure` 会给出 0 或“设备不支持”的默认值（常见是 0.5）。
  - 如果把 pen 的 fallback 当成 0.5，再叠加 `pressureCurve='soft'`，轻压会被显著放大，导致首 dab 变重。

- **WinTab `currentPoint` 可能是上一笔残留**（事实）
  - `currentPoint` 是“最后一次 WinTab 输入”，如果 stroke 刚开始时直接读它，有机会读到上一笔的数据。
  - 这在 build-up “首点立刻产 dab” 的语义下，会被放大成肉眼可见的起笔 blob。

- **starting 阶段 buffering + replay 可能原地堆很多点**（事实）
  - WinTab/raw input 可能在 beginStroke await 期间塞入多个几乎同坐标的点。
  - replay 如果逐个处理，会在同一点连续 stamp 多次，进一步加重起笔 blob。

## 解决方案（v1 现状）
### A) Build-up tick 速率改为 5Hz（更接近 PS）
- 将补点从 60Hz 调整为 5Hz（200ms/次），并限制每帧最多补 1 次，避免卡顿时 catch-up 爆发。
- 经验：PS 的体感更像“timer 驱动”的喷涂，而不是每帧都 stamp。

### B) 起笔压力来源收敛与去“伪压感”
- pointerdown：pen 在无可靠样本时不再默认 0.5（改为 0），避免轻压起笔被抬高。
- WinTab buffering：仅在时间戳接近当前 PointerEvent 的情况下使用 WinTab 点；并优先使用“<= eventTime 的最近点”，避免“向未来取样”带来压力尖峰。
- build-up tick：仅在 `currentPoint` 时间戳足够新鲜时才使用，避免用到上一笔残留压力。

### C) starting replay 降低“起笔堆叠”
- Build-up + CPU 下，starting replay 对“近似同点”的连续点做折叠（只保留最后一个）。
- 如果存在后续点（意味着很快就能拿到更可信的 move/raw 压力），replay 会跳过首个 PointerDown 点，减少“首点压力不准导致首 dab 过重”的概率。

## 验证方式
- RenderMode=cpu
- 开启 Build-up，opacity 压感打开，轻压起笔：
  - 观察起笔 blob 是否明显减弱
  - 原地按住 1s：积累速度是否接近 PS
- 对比：关闭 Build-up 时原地按住不应继续变化。

## 教训 / 可复用经验
1) **pen 的 pressure fallback 不能用 0.5**：在 WinTab 场景里，0.5 往往是“未知/不支持”的伪值，会直接污染首 dab。
2) **`currentPoint` 作为“最后值”需要防 stale**：尤其在“首点立即出墨”的语义下，任何上一笔残留都会被放大。
3) **starting 阶段的 buffering/replay 需要去抖**：否则容易把“等待 beginStroke 的时间”误当成用户想要的喷涂密度。
4) **Build-up 更像一个 timer**：与 mouse/wacom 都能工作这一点一致，建议用固定频率驱动而不是依赖输入事件密度。

## 后续 TODO
- 把 build-up tick 的频率作为可调参数（或做与 brush spacing / size 的经验映射），避免不同笔刷体感差异过大。
- 若仍有极端设备/驱动导致的首 dab 偏重：考虑在 build-up 模式对“首个 dab”做更明确的 gating（例如必须观察到一次可信的 tablet sample 才允许首 dab 直接出墨）。

