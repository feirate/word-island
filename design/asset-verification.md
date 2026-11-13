# 三维资产验收记录

## 已执行

- 使用已有 Blender 4.5.15 LTS，执行 `tools/build_world.py`，实际生成四份 GLB 与四份压缩 Blender 母版，进程正常退出。
- 四份 GLB 分别通过 `scene-to-three/scripts/validate_glb.py`。
- 在本机静态服务的实际产品页面中，通过 GLTFLoader 加载四份模型、原始材质与真实动画。
- 实际浏览器检查小屋、营地，分别检查芽芽和团团的正面、侧面、背面、斜侧以及 idle 动作中的一帧。
- 运行 `design/check-assets.cjs`：四份模型均已加载，八个物件语义节点存在，两个角色均有真实动画片段；头部控制组各包含 13 个子对象，片段推进后头部四元数确实改变；未观察到页面脚本错误。

## 导出统计

| 资产 | GLB 包体 | 网格 | 三角形 |
| --- | ---: | ---: | ---: |
| home | 1,825,956 bytes | 35 | 40,960 |
| camp | 2,287,232 bytes | 30 | 70,276 |
| hero | 534,488 bytes | 32 | 22,790 |
| bunny | 450,344 bytes | 22 | 19,576 |

模型使用标准材质，无外部纹理或外网依赖。角色躯干和头脸已实际融合建模；头部的眼睛、口鼻、耳朵处于同一可联动层级。模型已检查的侧背面没有明显破洞或失去主体辨识度的问题，围巾、背包和尾巴有三维厚度。

## 画面证据

- `screenshots/home-three.png`：固定小屋、书架、线索板、真实门和主角。
- `screenshots/camp-three.png`：营地、食物箱、告示牌、邮筒、宝箱和两位角色。
- `screenshots/hero-{front,side,back,three-quarter,idle-extreme}.png`：芽芽多角度与动作帧。
- `screenshots/bunny-{front,side,back,three-quarter,idle-extreme}.png`：团团多角度与动作帧。
- `asset-runtime-check.json`：实际加载、节点、动画与浏览器错误检查结果。

初次整体截图发现营地树冠及小屋后墙顶角取景偏紧，已反馈应用世界视图调整相机目标与画幅。产品最终构图须以调整后的整体截图为准。

## 实际边界

当前检查在本机桌面 Chrome 的 WebGL2 中完成，不代表 iPhone / iPad 真机性能、触屏拾取或系统语音已全部验收；真实手机体验由产品集成验证及孩子试用补充。未制作自然行走、战斗、骨骼步态或口型。现有 idle 为呼吸、轻转头和耳摆。

`design/check-assets.cjs` 需要本地已可用的 Playwright 与浏览器；可通过 `WORD_ISLAND_PLAYWRIGHT` 指定模块路径、`WORD_ISLAND_CHROME` 指定 Chrome 可执行文件。该工具只用于内部验收，不是产品入口，也不在孩子界面中显示诊断控制。
