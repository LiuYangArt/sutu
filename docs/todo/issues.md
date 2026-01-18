compute shader笔刷完成
后续笔刷需要优化抗锯齿

eraser 复用笔刷系统

---

## 绘图基础功能

- 图层删除按钮不需要每个图层都有， 放到最上

- 图层改名， 选中图层按f2. 新建图层 alt+n.

---

photoshop 笔刷关键参数

buildup
笔刷戳在原地，即使只持续输入相同压感， 也会持续变深（叠加）. 但是应该有个threshold， 可能跟当前压感相关（例如特别轻的输入时，不会给你叠到满）,或者可能是在同一个点buildup的次数限制。 我测试感觉是笔刷不动， 且持续输入的压感在差不多的一个范围内时， build up 最多叠加三次

增加wintab/windows ink切换

ui 模块化， dockable ui panels
tools（brush / eraser /zoom等）拆到单独的悬浮panel

增加menu button 》 settings
设置页面 左边分类tab， 右边详细设置
