# Noise 笔刷功能设计

## 背景

Photoshop 笔刷面板中的 Noise 选项可以在笔刷边缘产生颗粒噪点效果，让笔触看起来更自然。

**核心发现**：Noise 的实现机制与 Texture 一致，区别仅在于纹理来源不同 —— Texture 使用用户选择的纹理图像，而 Noise 使用程序生成的噪点纹理。

## 需求确认

| 项目       | 确认内容                                                 |
| ---------- | -------------------------------------------------------- |
| 功能类型   | 纯开关，无额外参数                                       |
| Noise 特性 | 固定，基于画布坐标（同坐标 → 同 noise 值）               |
| Noise 大小 | **绝对像素值**，不随笔刷大小变化（使用画布像素坐标采样） |
| 复用方案   | 复用现有 Texture 渲染逻辑                                |

## 方案设计

### 核心思路

生成一张程序化 Noise 纹理，作为"内置 Pattern"使用。启用 Noise 时，自动应用这张纹理，参数使用固定的默认值。

---

## Proposed Changes

### Noise 纹理生成模块

#### [NEW] [noiseTexture.ts](file:///f:/CodeProjects/PaintBoard/src/utils/noiseTexture.ts)

生成程序化 Noise 纹理，返回 `PatternData` 格式。

```typescript
// 使用 Value Noise 或 Simplex Noise 算法
// 尺寸：256x256（tileable，无缝拼接）
// 输出格式：与 Pattern 一致的 RGBA Uint8ClampedArray

export function generateNoisePattern(size: number = 256): PatternData {
  // 1. 使用确定性随机数生成（基于固定 seed）
  // 2. 生成灰度噪声图
  // 3. 转换为 RGBA 格式
  // 4. 返回 PatternData
}

// Singleton 缓存，避免重复生成
let cachedNoisePattern: PatternData | null = null;
export function getNoisePattern(): PatternData;
```

---

### Store 扩展

#### [MODIFY] [tool.ts](file:///f:/CodeProjects/PaintBoard/src/stores/tool.ts)

添加 Noise 开关状态：

```diff
interface ToolState {
  // ... existing fields
+ noiseEnabled: boolean;
}

// 默认值
+ noiseEnabled: false,

// Action
+ setNoiseEnabled: (enabled: boolean) => void;
```

---

### 渲染集成

#### [MODIFY] [useBrushRenderer.ts](file:///f:/CodeProjects/PaintBoard/src/components/Canvas/useBrushRenderer.ts)

在 dab 渲染时应用 Noise 纹理：

```typescript
// 在 stampToBuffer / stampHardBrush 调用前后：
if (noiseEnabled) {
  const noisePattern = getNoisePattern();
  // 使用 calculateTextureInfluence 计算 noise 影响
  // 固定参数：depth=100%, mode='subtract', scale=100
}
```

> [!NOTE]
> Noise 与 Texture 可以同时启用，效果叠加。应用顺序：先 Texture，后 Noise。

---

### UI 更新

#### [MODIFY] [BrushPanel/index.tsx](file:///f:/CodeProjects/PaintBoard/src/components/BrushPanel/index.tsx)

移除 `disabled: true`：

```diff
- { id: 'noise', label: 'Noise', disabled: true },
+ { id: 'noise', label: 'Noise' },
```

添加 case 处理：

```typescript
case 'noise':
  return <NoiseSettings />;
```

#### [NEW] [NoiseSettings.tsx](file:///f:/CodeProjects/PaintBoard/src/components/BrushPanel/settings/NoiseSettings.tsx)

极简 UI，只包含一个开关：

```tsx
export function NoiseSettings(): JSX.Element {
  const { noiseEnabled, setNoiseEnabled } = useToolStore();

  return (
    <div className="p-4">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={noiseEnabled}
          onChange={(e) => setNoiseEnabled(e.target.checked)}
        />
        <span>Enable Noise</span>
      </label>
      <p className="text-xs text-gray-500 mt-2">
        Adds random grain to brush edges for a more natural look.
      </p>
    </div>
  );
}
```

---

## Verification Plan

### 自动化测试

1. **单元测试** (`noiseTexture.test.ts`)
   - 验证 noise 纹理的确定性：同坐标多次调用返回相同值
   - 验证纹理尺寸和格式正确
   - 验证值分布在 0-255 范围内

2. **渲染测试**
   - 验证 noiseEnabled=true 时 dab 输出与 noiseEnabled=false 不同
   - 验证 Noise + Texture 同时启用时效果正确叠加

### 手动验证

- 与 Photoshop Noise 效果进行视觉对比
- 验证在不同笔刷大小下 Noise 颗粒感一致

---

## 实现顺序

1. [ ] `noiseTexture.ts` - 实现 noise 纹理生成
2. [ ] `noiseTexture.test.ts` - 单元测试
3. [ ] `tool.ts` - 添加 noiseEnabled 状态
4. [ ] `useBrushRenderer.ts` - 集成 noise 渲染
5. [ ] `NoiseSettings.tsx` - UI 组件
6. [ ] `BrushPanel/index.tsx` - 启用 Noise tab
7. [ ] 视觉验证与调参

---

## 风险与不确定性

| 风险                                 | 影响             | 缓解措施           |
| ------------------------------------ | ---------------- | ------------------ |
| Noise scale/depth 固定值与 PS 不匹配 | 视觉效果偏差     | 需要与 PS 对比调参 |
| GPU 渲染路径未集成                   | GPU 笔刷无 Noise | Phase 2 扩展       |

---

## 置信度

**85%** — 方案简洁，复用现有逻辑，主要不确定性在于参数微调。
