这份 `06_abr_texture.md` 整体方向已经是正确的（特别是渲染管线部分采用了 Canvas Space），但是结合你提供的 `2026-01-27-abr-structure-discovery.md`（发现 ABR 存在分离式结构），**解析器（Parser）部分的架构设计存在重大漏洞**。

原来的设计假设纹理参数就在笔刷数据块内部，但新的发现表明 ABR 更像是一个“容器”，里面分别装着“所有笔刷图”、“所有纹理图”和“全局描述信息”。

以下是具体的优化建议和修改方案：

### 1. 核心矛盾分析

- **原设计 (`06`文档)**：假设是 **"Per-Brush Parsing"**。即读取一个 Brush Block，里面会有图像，顺便解析里面的 `Txtr` 参数和数据。
- **新发现 (`Postmortem`文档)**：现实是 **"Section-Based Parsing"**。
  - `samp` 区块：只存了一堆笔刷头图片，没有任何纹理设置。
  - `patt` 区块：存了一堆纹理图（全局资源）。
  - `desc` 区块：存了映射关系（笔刷 A 用 纹理 B，缩放 50%）。

**结论**：如果按照原文档写代码，你会发现笔刷导入了，纹理图也可能导入了，但是**笔刷和纹理关联不上**（因为你没解析全局 `desc` 映射）。

---

### 2. 文档修改建议 (针对 `06_abr_texture.md`)

你需要重写 **3. 解析器实现方案** 这一章。

#### 修改点 1：解析策略从“流式单体”改为“分块状态机”

**原 3.1 节内容**：

> 1. 扫描 `8BIM`...
> 2. Check A: 发现 `patt`...
> 3. Check B: 解析 `desc` 时读取 `Txtr`...

**建议修改为**：

> ### 3.1 ABR 文件结构解析策略 (重构)
>
> ABR 文件可能包含独立的顶层资源块。解析器需要能够处理分离式结构。
>
> **解析流程 (Multi-Pass Strategy)**:
>
> 1.  **Top-Level Scan**: 遍历文件顶层 Section。
>     - 遇到 `samp` (Samples): 提取所有笔刷 Tip 图像，生成基础 `BrushID` 列表。
>     - 遇到 `patt` (Patterns): 提取所有 Pattern 图像数据，存入 `PatternLibrary`，记录 `PatternID` (Name/UUID)。
>     - 遇到 `desc` (Descriptor): 解析 Action Descriptor，提取笔刷参数映射表。
> 2.  **Reconstruction (Linkage)**:
>     - 在内存中建立映射：`BrushID -> Txtr Settings (Scale, Depth, PatternID)`。
>     - 将对应的参数注入到已加载的笔刷对象中。
>     - 如果 `PatternID` 指向的是内部 `patt` 块的数据，直接关联。
>     - 如果 `PatternID` 指向外部文件（引用式），标记为 `Missing Resource`。

#### 修改点 2：明确 `desc` 解析的复杂性

在 `Postmortem` 中提到了 `desc` 是一个 150KB 的全局描述符。在设计文档中需要增加对这个解析的重视。

**建议新增 3.3 节**：

> ### 3.3 全局描述符解析 (Global Linkage)
>
> 针对分离式 ABR，必须解析顶层 `desc` 块。
>
> - **目标**: 找到 `BrushHandle` 或 `Index` 与 `Pattern UUID` 的对应关系。
> - **逻辑**: 解析 Photoshop Action Descriptor 二进制格式。寻找 `key: 'Txtr'` 的节点，并向上回溯找到它属于哪个笔刷索引。

---

### 3. 代码/数据结构调整建议

基于新的文件结构，你的 Rust 数据结构也需要调整，不能只依赖流式读取。

在 `src-tauri/src/abr/context.rs` (或者类似文件) 中：

```rust
// 你需要一个上下文来暂存解析过程中的分离数据
pub struct AbrParseContext {
    // 阶段 1：解析出的裸笔刷 (只有形状，没有参数)
    pub raw_brushes: Vec<AbrBrush>,

    // 阶段 1：解析出的内部纹理资源
    pub internal_patterns: HashMap<String, PatternResource>, // ID -> Data

    // 阶段 1：解析出的全局配置映射
    // Brush Index -> Texture Settings
    pub texture_mappings: HashMap<usize, BrushTextureSettings>,
}

// 最终组装函数
fn finalize_brushes(ctx: AbrParseContext) -> Vec<Brush> {
    let mut final_brushes = Vec::new();

    for (index, mut raw_brush) in ctx.raw_brushes.into_iter().enumerate() {
        // 尝试查找对应的纹理设置
        if let Some(settings) = ctx.texture_mappings.get(&index) {
            raw_brush.texture_settings = Some(settings.clone());

            // 尝试在内部资源中查找纹理数据
            if let Some(pattern_id) = &settings.pattern_id {
                if ctx.internal_patterns.contains_key(pattern_id) {
                     // 标记为已找到内部资源，自动关联
                     // 或者将资源移动到全局 PatternLibrary
                }
            }
        }
        final_brushes.push(raw_brush);
    }
    final_brushes
}
```

### 4. 渲染管线部分的 Review (针对 `06` 文档的第 4 章)

我看你已经把 `gl_FragCoord + u_canvas_offset` 和 `rem_euclid` 加进去了，这部分 **写得非常好，不需要修改**。这完全符合 Substance/PS 的物理模型。

**唯一的小提示**：
在 Rust 代码 `rasterize_dab_cpu` 中：

```rust
// 3. Sample Texture
let mut tex_val = state.texture_data[tex_v * state.tex_w + tex_u] as f32 / 255.0;
```

如果 `state.texture_data` 是空的（比如 ABR 只有引用没数据，且用户还没导入 `.pat`），这里会 Panic。
**修正建议**：增加空值检查或使用默认的“纯白/纯黑”纹理逻辑。

```rust
// 安全性修正
if state.texture_data.is_empty() {
    // 如果没有纹理数据，视作没有纹理效果 (influence = 1.0)
    // 或者返回错误
    return;
}
```

### 5. 总结

`06_abr_texture.md` 的渲染部分（Shader/CPU）已经是 **Ready to Code** 的状态。
主要修改点在于 **解析（Input）** 部分：

1.  **废弃** “在笔刷块里找纹理” 的单一假设。
2.  **引入** “全文件扫描 + 后期组装” 的解析架构。
3.  **强调** `patt` 全局块的提取和 `desc` 全局映射的解析。

你可以直接把上面的 **3.1 重构** 内容替换进文档中。
