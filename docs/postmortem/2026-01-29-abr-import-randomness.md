# 2026-01-29 ABR Import Randomness

## 1. 问题描述 (Problem Description)

用户反馈 ABR 笔刷导入后名字匹配错误（例如 "Sampled Brush 5" 显示为 "Soft Round 500 1"），且每次重新导入时结果不一致（"Randdomly matched"）。

## 2. 根本原因分析 (Root Cause Analysis)

### 2.1 现象回顾

- **Mismatch**: 初始单纯基于索引（Index-based）的匹配失败，因为 `samp`（图像）数量与 `desc`（描述符）数量不一致（71 vs 79）。
- **UUID Approach**: 引入 UUID 匹配后，部分笔刷（如 Index 40）匹配成功，但部分笔刷（如 Index 6 "Brush_7"）匹配失败。
- **Fallback Chaos**: 引入 "Sequential Fallback"（顺序回退）策略后，试图将剩余的笔刷按顺序分配给剩余的描述符，导致了错配。
- **Randomness**: 用户观察到的随机性是关键线索。

### 2.2 技术根因 (Technical Root Cause)

我们在 `parser.rs` 中引入的 `find_uuid` 函数存在严重的非确定性行为（Non-determinism）。

```rust
fn find_uuid(val: &DescriptorValue) -> Option<String> {
    match val {
        DescriptorValue::Descriptor(d) => {
            // ... check 'sampledData' ...
            for v in d.values() { // <--- 致命错误
                if let Some(res) = find_uuid(v) { return Some(res); }
            }
        }
        // ...
    }
}
```

1.  **HashMap Iteration**: `Descriptor` 的底层实现是 `HashMap<String, DescriptorValue>`。在 Rust 中，`HashMap` 的迭代顺序是不确定的（默认使用 RandomState 哈希器）。
2.  **Ambiguous Data**: ABR 描述符结构非常复杂，同一个 `Identifier` 可能会出现在多个位置（例如：作为自身的 UUID，引用 Parent 的 UUID，或者作为 Pattern 的 UUID）。
3.  **Race Condition**:
    - 如果一个描述符包含**多个**潜在的 UUID 字符串（例如 `UUID_A` 和 `UUID_B`）。
    - 其中 `UUID_A` 是我们需要的（能匹配到 Brush Image）。
    - `UUID_B` 是无关的（不能匹配到 Brush Image）。
    - 由于 `d.values()` 迭代顺序随机：
      - **情况 1**: 先遍历到 `UUID_A` -> `find_uuid` 返回 A -> 匹配成功 -> 描述符被标记为 "Used"。
      - **情况 2**: 先遍历到 `UUID_B` -> `find_uuid` 返回 B -> 匹配失败（没有笔刷拥有 UUID B） -> 描述符保持 "Unused"。
4.  **Cascading Failure**: 一旦描述符错误地判定为 "Unused"，它就会掉入 Fallback 队列。Fallback 队列的顺序取决于哪些描述符被随机判定为 Unused，从而导致所有后续的回退匹配全部乱序。

## 3. 经验总结 (Lessons Learned)

### 3.1 永远不要信任 HashMap 的顺序

在涉及数据解析、序列化或确定性算法时，**严禁**直接通过 `values()` 或 `keys()` 迭代 `HashMap`，除非你并不关心结果的顺序。
**修正方案**: 必须对 Keys 进行排序 (`keys().sorted()`) 后再进行确定性遍历，或者明确指定查找路径（如 `d.get("key")`），避免盲目递归。

### 3.2 避免建立在不稳定基础上的 Fallback

我们过早地引入了 Fallback 策略来掩盖 "Brush 7" 无法匹配的问题。

- **错误决策**: "Brush 7 没匹配上，那就用剩下的凑合配一个"。
- **正确思路**: "Brush 7 为什么没匹配上？是 UUID 找错了？还是路径不对？"
  如果基础匹配逻辑（UUID Search）本身是不稳定的（有时能找到有时找不到），那么在其之上构建任何 Fallback 都会放大这种不稳定性。

### 3.3 验证的深度

我们在验证时虽然使用了 `verify_brush_names` 脚本，但往往只关注了 "Target Found"（找到了目标笔刷），而忽略了整个系统的稳定性（多次运行是否一致）。

## 4. 解决方案 (Action Plan)

为彻底解决此问题，需执行以下步骤：

1.  **废弃盲目递归**: 删除 `find_uuid` 中的 `d.values()` 任意遍历。
2.  **实施精确路径查找**:
    - 仅在确定的 Key 中查找 UUID（如 `sampledData`）。
    - 如果必须递归，必须按照 Key 的字典序遍历，保证确定性。
    - 或者，收集描述符中的**所有** UUID 候选者，优先匹配能 link 到笔刷的那一个。
3.  **移除不可靠的 Fallback**: 当 UUID 匹配逻辑修复后，如果 ABR 数据结构设计合理，理论上不需要 Fallback，或者 Fallback 仅应针对真正没有任何 Metadata 的笔刷（通过明确的特征判断，而非排除法）。

## 5. 结论

目前的 "Random Mismatch" 是非确定性算法与数据歧义共同作用的结果。必须重构 UUID 提取逻辑以保证 100% 的确定性。
