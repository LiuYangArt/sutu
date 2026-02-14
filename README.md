## 注意

这是一个纯vibe-coding的实验性项目，代码都是ai写的，我一点都看不懂。请谨慎使用。

# Sutu (速涂)

个人用绘画软件，支持 Wacom 压感输入，基于 Tauri + React + Rust 构建。当前支持 Windows / macOS 双平台。
数位板输入链路采用平台原生后端优先（Windows: WinTab，macOS: Mac Native），并保留 PointerEvent 作为通用回退。
使用gpu compute shader笔刷，对显卡/显存有一定要求。
目标是做一个接近ps绘画体验的轻量级项目。
支持ps的abr笔刷文件导入，支持大部分笔刷属性。

## 下载

在Release中下载最新的安装包。
[https://github.com/LiuYangArt/sutu/releases](https://github.com/LiuYangArt/sutu/releases)

## bug反馈和新功能需求
在此提交issue [https://github.com/LiuYangArt/sutu/issues](https://github.com/LiuYangArt/sutu/issues)

## 许可证

本项目采用 GNU General Public License v3.0（GPL-3.0-only）。
完整条款见仓库根目录 `LICENSE`。
