## 注意

这是一个纯vibe-coding的实验性项目，代码都是ai写的，我一点都看不懂。请谨慎使用。

# PaintBoard

个人用绘画软件，支持 Wacom 压感输入，基于 Tauri + React + Rust 构建。目前只支持windows平台。 
当前主链路为 GPU-First（WebGPU + Tile）：实时绘画默认不做 readback，仅在导出/截图时执行分块 readback。
目标是做一个接近ps绘画体验的轻量级项目。
支持ps的abr笔刷文件导入，支持大部分笔刷属性。

## 下载

在Release中下载最新的安装包 [https://github.com/LiuYangArt/PaintBoard/releases/](https://github.com/LiuYangArt/PaintBoard/releases/)


