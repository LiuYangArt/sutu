# 笔刷系统 UI/UX 设计

> 对应原文档 Phase 4

## Phase 4: 笔刷预设 UI

### 4.1 组件结构

```
src/components/BrushPanel/
├── index.tsx              # 主面板容器
├── BrushPresetGrid.tsx    # 预设网格（缩略图）
├── BrushPresetItem.tsx    # 单个预设项
├── BrushSettings.tsx      # 详细参数编辑
├── BrushTipEditor.tsx     # 笔尖参数
├── DynamicsEditor.tsx     # 动态参数
├── ImportDialog.tsx       # ABR 导入对话框
└── BrushPanel.css         # 样式
```

### 4.2 状态管理

```typescript
// src/stores/brush.ts

interface BrushPreset {
  id: string;
  name: string;
  thumbnail: string; // base64 data URL
  tip: {
    type: 'round' | 'sampled';
    diameter: number;
    hardness: number;
    angle: number;
    roundness: number;
    spacing: number;
  };
  dynamics: {
    size: DynamicControl;
    opacity: DynamicControl;
    angle: DynamicControl;
  };
  scatter: {
    enabled: boolean;
    amount: number;
    count: number;
  };
  fromAbr: boolean;
}

interface DynamicControl {
  control: 'off' | 'pressure' | 'tilt' | 'direction' | 'fade';
  jitter: number;
  minimum: number;
}

interface BrushState {
  presets: BrushPreset[];
  activePresetId: string | null;
  isLoading: boolean;

  // Actions
  loadPresets: () => Promise<void>;
  importAbr: (path: string) => Promise<void>;
  setActivePreset: (id: string) => void;
  updatePreset: (id: string, updates: Partial<BrushPreset>) => void;
  deletePreset: (id: string) => void;
  savePreset: (preset: BrushPreset) => Promise<void>;
}

export const useBrushStore = create<BrushState>((set, get) => ({
  presets: [],
  activePresetId: null,
  isLoading: false,

  loadPresets: async () => {
    set({ isLoading: true });
    try {
      const presets = await invoke<BrushPreset[]>('get_brush_presets');
      set({ presets, isLoading: false });
    } catch (e) {
      console.error('Failed to load presets:', e);
      set({ isLoading: false });
    }
  },

  importAbr: async (path: string) => {
    set({ isLoading: true });
    try {
      const newPresets = await invoke<BrushPreset[]>('import_abr_file', { path });
      set((state) => ({
        presets: [...state.presets, ...newPresets],
        isLoading: false,
      }));
    } catch (e) {
      console.error('Failed to import ABR:', e);
      set({ isLoading: false });
      throw e;
    }
  },

  // ... other actions
}));
```

### 4.3 UI 设计稿

```
┌─────────────────────────────────────────┐
│  Brushes                          [+] │  ← 标题 + 导入按钮
├─────────────────────────────────────────┤
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│ │     │ │     │ │     │ │     │       │  ← 预设网格
│ │ ○   │ │ ○   │ │ ✿   │ │ ★   │       │    (缩略图)
│ │     │ │     │ │     │ │     │       │
│ └─────┘ └─────┘ └─────┘ └─────┘       │
│  Hard    Soft    Leaf   Sparkle       │
│                                         │
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       │
│ │     │ │     │ │     │ │     │       │
│ ...                                    │
├─────────────────────────────────────────┤
│  Brush Tip                              │  ← 展开式设置
│  ├─ Size:     [====●====] 20px         │
│  ├─ Hardness: [●========] 100%         │
│  ├─ Spacing:  [==●======] 25%          │
│  └─ Angle:    [====●====] 0°           │
├─────────────────────────────────────────┤
│  Shape Dynamics                    [▼] │
│  ├─ Size:     [Pressure ▼] Jitter: 0%  │
│  └─ Angle:    [Direction▼] Jitter: 0%  │
├─────────────────────────────────────────┤
│  Transfer                          [▼] │
│  └─ Opacity:  [Pressure ▼] Jitter: 0%  │
└─────────────────────────────────────────┘
```
