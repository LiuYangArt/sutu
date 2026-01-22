# Custom Protocol Cache MISS 问题

## 日期
2025-01-22

## 问题描述

实现 `project://` 自定义协议用于加载图层图像时，缓存写入成功但读取时返回 MISS。

### 症状
```
INFO Caching layer: layer_1 (8294400 bytes)  ← 写入成功
INFO ORA load complete: 1 layers cached
...
INFO Looking up layer in cache: layer_1
WARN Cache MISS: layer_1                      ← 读取失败
```

### 影响
- 打开第一个 ORA 文件：图层图像加载失败
- 打开第二个 ORA 文件：程序崩溃

## 根因分析

### 尝试的解决方案

1. **使用 `if let Ok()` 替代 `unwrap()`** - 无效
   - 假设 `std::sync::RwLock` 被 poison
   - 但静默失败无法解决问题

2. **添加 `parking_lot::RwLock`** - 未验证
   - `parking_lot::RwLock` 不会 poison
   - 但问题可能不是 poison 导致

### 可能的真正原因

1. **Tauri 自定义协议运行在不同线程**
   - `register_uri_scheme_protocol` 的回调可能在 WebView 线程执行
   - 与 Tauri 命令（`load_project`）运行在不同线程
   - 两个线程可能持有不同的 static 变量副本？

2. **静态变量初始化时机**
   - `static LAYER_CACHE: RwLock<Option<LayerCache>>` 可能在不同上下文有不同实例
   - 需要确认 Rust 静态变量在 Tauri 多线程环境的行为

3. **Windows 平台特定问题**
   - Windows 上自定义协议 URL 格式为 `http://project.localhost/...`
   - 可能有额外的隔离或沙盒机制

## 待验证

1. 在 `cache_layer_png` 和 `get_cached_layer` 中打印线程 ID
2. 确认两个函数是否在同一线程执行
3. 考虑使用 `lazy_static!` 或 `once_cell` 替代直接 static

## 临时解决方案

回退到第一阶段优化（ORA 直接透传 PNG 字节为 Base64），跳过自定义协议：

```rust
// ora.rs - 回退代码
layer.image_data = Some(BASE64.encode(&img_data));
```

## 经验教训

1. **Tauri 自定义协议的线程模型需要深入理解**
   - 协议处理器运行在哪个线程？
   - 如何安全地在协议处理器和命令之间共享状态？

2. **全局静态变量在多线程环境的陷阱**
   - `std::sync::RwLock` 的 poison 机制
   - 不同线程可能看到不同的内存视图

3. **渐进式开发的重要性**
   - 第一阶段的 Base64 直接透传已经带来 >50% 的性能提升
   - 自定义协议是更激进的优化，需要更多调研

## 后续行动

- [ ] 调研 Tauri 自定义协议的线程模型
- [ ] 查看 Tauri 社区是否有类似问题
- [ ] 考虑使用 Tauri State 管理替代全局静态变量
- [ ] 或者使用临时文件替代内存缓存

## 相关文件

- `src-tauri/src/file/layer_cache.rs` - 图层缓存实现
- `src-tauri/src/lib.rs` - 自定义协议注册
- `src-tauri/src/file/ora.rs` - ORA 加载逻辑
- `src/components/Canvas/index.tsx` - 前端图层加载
