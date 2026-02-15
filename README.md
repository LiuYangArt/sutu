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

## macOS 安装说明（当前未 Apple Developer 签名）

目前项目还没有 Apple Developer Program 签名与公证，首次打开时 macOS 可能提示“无法验证开发者”。

请按以下步骤安装：

1. 在 Release 下载 `.dmg`，双击挂载后把 `Sutu.app` 拖到“应用程序”。
2. 不要直接双击打开应用，先在“应用程序”里对 `Sutu.app` 右键，选择“打开”。
3. 弹出安全提示后，再点一次“打开”。
4. 如果仍被拦截：进入“系统设置 -> 隐私与安全性”，在底部找到 `Sutu` 的拦截提示，点击“仍要打开”。

预期结果：完成一次放行后，后续可以正常双击启动。

## bug反馈和新功能需求
在此提交issue [https://github.com/LiuYangArt/sutu/issues](https://github.com/LiuYangArt/sutu/issues)

## 许可证

本项目采用 GNU General Public License v3.0（GPL-3.0-only）。
完整条款见仓库根目录 `LICENSE`。
