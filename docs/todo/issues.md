感觉gpu比cpu笔刷延时大，可能是什么原因？
考虑 1. benchmark 增加cpu测试2. 为什么krita纯cpu笔刷这么快3. 考虑200px以下笔刷用cpu，200以上gpu，混合构架

---

## 绘图基础功能

1. 增加前景色/背景色

- 快捷键d 把前景色设为黑色， 背景色设为白色
- 快捷键x 交换前景色，背景色

  2.吸色时，现在是crosshair cursor图标，换成吸管图标，记得使用硬件图标（参考画图时笔刷圆圈的实现）

  3.图层应该只有最前面的handel才能拖拽换位置

  4.图层改名， 选中图层按f2. 新建图层 alt+n.

  5.alt+backspace 用前景色填充当前图层。

---

增加wintab/windows ink切换

ui 模块化， dockable ui panels
tools（brush / eraser /zoom等）拆到单独的悬浮panel

增加menu button 》 settings
设置页面 左边分类tab， 右边详细设置
