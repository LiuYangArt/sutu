# ABR 笔刷名字匹配随机性问题

**日期**: 2026-01-30
**严重程度**: High
**影响范围**: ABR 导入功能
**状态**: 已修复

## 问题描述

用户导入 ABR 文件后，每次重启应用再导入同一文件，笔刷与名字的匹配结果**完全随机**——同一个笔刷有时名字正确，有时错误，有时没有匹配到。

## 根因分析

### 直接原因

`find_uuid` 函数在遍历描述符字段时使用 `d.values()` 迭代 HashMap：

```rust
// descriptor.rs:14
pub enum DescriptorValue {
    Descriptor(HashMap<String, DescriptorValue>),  // ← 问题所在
    ...
}

// parser.rs:659
for v in d.values() {  // ← 迭代顺序不确定
    if let Some(res) = find_uuid(v) {
        return Some(res);
    }
}
```

Rust 的 `HashMap` 使用 `RandomState` 作为默认哈希器，**每次程序启动时哈希种子不同**，导致 `values()` 的迭代顺序不确定。

### 为什么这会导致问题

ABR 描述符中存在**多个嵌套的 `sampledData` 字段**：

```
Desc #19: 'Sampled Brush 3 12'
  ├── Brsh.sampledData: 54081195-...  (主笔刷 UUID)
  └── dualBrush.Brsh.sampledData: 411bc9f4-...  (双笔刷 UUID)
```

当 `find_uuid` 递归搜索时，**先遇到哪个字段取决于 HashMap 的迭代顺序**，而这个顺序每次启动都不同。

### 因果链

```
HashMap 使用随机哈希种子
    ↓
d.values() 迭代顺序不确定
    ↓
find_uuid 返回不同的 sampledData UUID
    ↓
笔刷匹配到不同的描述符
    ↓
用户看到随机的笔刷名字
```

## 修复方案

将 `HashMap` 替换为 `IndexMap`（保持插入顺序）：

```diff
- use std::collections::HashMap;
+ use indexmap::IndexMap;

  pub enum DescriptorValue {
-     Descriptor(HashMap<String, DescriptorValue>),
+     Descriptor(IndexMap<String, DescriptorValue>),
      ...
  }
```

**为什么选择 IndexMap**：

- 保持键的插入顺序（ABR 文件解析顺序固定）
- API 与 HashMap 完全兼容
- 性能影响可忽略（描述符数量有限）

## 相关文件

- [descriptor.rs](file:///f:/CodeProjects/PaintBoard/src-tauri/src/abr/descriptor.rs) - `DescriptorValue` 类型定义
- [parser.rs](file:///f:/CodeProjects/PaintBoard/src-tauri/src/abr/parser.rs) - `find_uuid` 函数和匹配逻辑

## 经验教训

### 1. HashMap 迭代顺序不可依赖

> **规则**: 任何依赖 HashMap 迭代顺序的逻辑都是 bug

Rust 的 `HashMap` 使用随机哈希种子，同一组数据在不同运行中迭代顺序可能不同。如果业务逻辑依赖顺序，必须使用：

- `IndexMap` - 保持插入顺序
- `BTreeMap` - 按键排序
- 显式排序后遍历

### 2. 非确定性问题难以调试

这类 bug 在单元测试中可能不会暴露（测试通常使用固定种子），只有在多次完整运行时才会出现。

**建议**：对于解析/匹配逻辑，增加"确定性测试"——多次运行同一输入，确认输出完全一致。

### 3. 递归搜索需要明确优先级

`find_uuid` 函数的设计目标是"找到第一个 sampledData"，但"第一个"的定义不明确：

- 文件中物理位置第一个？
- 嵌套深度最浅的？
- 按键名排序后第一个？

修复后使用 IndexMap 保持了"解析顺序第一个"的语义。

## 验证

1. 多次重启应用并导入同一 ABR 文件
2. 确认同一笔刷的名字每次都相同
3. 运行 `cargo run --example debug_brush_names` 确认结果稳定
