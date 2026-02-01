# 2026-01-31 Duplicate Brush ID Fix Postmortem

## 1. Summary

修复了导入 ABR 笔刷时，由于 ABR 文件内部 UUID 重复导致 UI 上多个笔刷同时被选中的 Bug。通过在后端导入时强制生成唯一 ID 解决了此问题。

## 2. Issue Description

**现象**:
在笔刷面板中点击某个导入的笔刷（特别是从 `liuyang_paintbrushes.abr` 导入的），UI 会同时高亮显示多个笔刷。

**影响**:
用户无法准确区分当前选中的是哪一个笔刷变体，体验困惑。且 React 渲染列表时控制台会有 `duplicate key` 警告。

## 3. Root Cause Analysis

**技术背景**:
PaintBoard 的笔刷系统使用 `id` 作为唯一标识符。此前，导入 ABR 时直接提取了 ABR 内部 `sampledData` (笔触采样数据) 的 UUID 作为笔刷 ID。

**根本原因**:
ABR (Photoshop Brush) 文件结构允许 **多个笔刷预设 (Preset) 共享同一个笔触采样 (Sampled Data)**。

- 笔刷 A: Tip UUID = `123`, Spacing = 10%
- 笔刷 B: Tip UUID = `123`, Spacing = 20% (变体)

代码逻辑直接使用了 Tip UUID，导致笔刷 A 和 B 拥有完全相同的 ID (`123`)。前端组件 `BrushPresets` 使用 ID 进行选中态判断 (`selectedId === brush.id`)，因此 AB 同时高亮。

## 4. Solution

**方案**: Backend Unique ID Enforcement

在 `src-tauri/src/commands.rs` 的 `import_abr_file` 函数中增加去重逻辑：

1.  引入 `HashMap<String, usize>` 记录本次导入中各 UUID 出现的次数。
2.  生成 ID 时，检查是否已存在。
3.  若存在，追加计数后缀。例如第一个为 `uuid`，第二个为 `uuid-1`，第三个为 `uuid-2`。
4.  确保这一生成的唯一 ID 同时用于：
    - `BrushPreset` 结构体返回给前端。
    - `BrushCache` (纹理缓存) 的 Key。虽然这意味着后端缓存中存了多份相同的纹理数据（指向同一份内存最好，但目前是 `Vec<u8>` 拷贝），但保证了前端通过 `project://brush/{unique_id}` 能正确加载到图片。

此方案优于在前端做 `index` 映射，因为它从源头保证了系统内 ID 的唯一性。

## 5. Lessons Learned

1.  **不要信任外部数据的唯一标识**: 第三方格式（如 ABR）中的 UUID 往往标识的是"资源"（Resource）而非"实例"（Instance）。在导入系统时，必须根据自身需求进行 ID 归一化。
2.  **Backend vs Frontend 职责**: 数据一致性问题（如 ID 唯一性）应尽早在 Backend 解决，避免 Frontend 为了由于数据脏乱而编写复杂的 hack 代码（如之前的 index 方案）。
3.  **缓存策略**: 虽然为了 ID 唯一性牺牲了一点内存（重复缓存纹理），但换来了架构的清晰和正确性。这是值得的权衡。未来可以通过 `Arc<Vec<u8>>` 来优化内存。

## 6. Action Items

- [x] 修复 `import_abr_file` 去重逻辑。
- [ ] (Optional) 优化 `BrushCache`，支持多 ID 指向同一份内存数据，减少内存占用。
