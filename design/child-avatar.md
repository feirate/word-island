# 小朋友主角三维资产

本轮根据用户“主角换成小朋友”的要求创作一位可爱的微缩小探险家，沿用现有伙伴和房间的暖色玩具风格。小朋友是用户在岛上的主角；原狐狸芽芽的 `hero.glb` 完整保留，由场景程序另作向导使用。本轮未重建或覆盖旧角色、伙伴和场景资产。

## 设计与保留项

- 小朋友具有圆脸、大头、小手脚、简洁短棕发、米白 T 恤、苔绿背带短裤、橘色小背包和小鞋。
- 人物轮廓使用真实有厚度的头、身体、手臂、腿、头发、耳朵和背包；不是平面图片或朝向相机的纸片。
- 头部的眼睛、眉毛、鼻子、微笑、耳朵和头发归属于同一头部控制组；上衣、背带裤、手臂和背包跟随呼吸躯干。鞋和小腿固定在根节点，呼吸时保持地面接触。
- 五官、发型、配色和衣服是本轮主动设计，不代表特定真实儿童。没有将用户名字刻入模型；姓名由界面在运行时显示，所有本地用户可复用同一份资产。
- 本轮提供轻微呼吸、点头与转头待机，不提供行走、口型、换装或复杂骨骼步态。

## 交付

| 文件 | 用途 |
| --- | --- |
| `assets/models/child.glb` | 页面使用的完整三维主角 |
| `assets/models/child.blend` | 可编辑 Blender 母版 |
| `assets/models/child-portrait.png` | 实际模型渲染的 256×256 姓名选择头像 |
| `assets/models/child-report.json` | 构建时的尺寸与文件统计 |
| `tools/build_child.py` | 可复现的 Blender 构建脚本 |
| `design/check-child-model.cjs` | 身份、头部层级、动画、体积预算与可编辑源检查 |
| `design/render-child.cjs` | 实际 Three.js 多角度、动作和头像检查 |

最终 GLB 为 **608,292 字节（约 594 KiB）**，**23,070 个三角形、20 个网格、17 个材质**，没有外部纹理请求。glTF 坐标为 Y 向上、正面 +Z，宽约 1.0098、高约 2.0607、深约 0.9112，静止最低点 y=0。场景中的实际大小由运行时缩放控制。

Blender 源坐标为 Z 向上、正面 -Y。根节点的 extras 为 `role=hero`、`assetId=child`，头部 `role=head`，躯干 `role=body`；不把用户名或应用互动 ID 写入模型。GLB 包含一段约四秒的 `Scene` 待机片段，片段首尾回到一致姿态。

## 制作与实际检查

已加载并遵循 `ub-mode` 和 `scene-to-three`，复用开发机既有 Blender 4.5.15 LTS、项目本地 Three.js r180 与基础几何制作函数；没有安装、下载、调用外部建模服务或执行 Git 提交、推送。

结构检查先确认 `child.glb` 不存在而失败，再构建资产。首稿导出超出约 600 KiB 的目标预算；降低小曲面分段并稍调头发融合分辨率后，在保留外观的同时降到预算内。多角度查看发现背包前带像孤立的橘色小段，随后把肩带沿肩、胸侧和腋下接回背包，正侧面均可见完整连接。

实际执行并通过：

1. `node design/check-child-model.cjs`：独立人物身份、完整头部与身体层级、真实头部旋转动画、单一协调待机、三角形与体积预算、Blender 母版存在。
2. `scene-to-three/scripts/validate_glb.py assets/models/child.glb`：GLB 结构、材质与顶点/三角形读取正常。
3. `node design/render-child.cjs`：使用本机 Chrome 和项目 Three.js 实际加载 GLB；查看正面、侧面、背面、三分之四角和待机极值；检查头部四元数随时间变化、片段回环一致、待机期间鞋底仍接地，未出现页面错误。

截图与实际运行数据在 `design/screenshots/child/`，包括 `front.png`、`side.png`、`back.png`、`three-quarter.png`、`idle-extreme.png` 和 `runtime-check.json`。头像由同一 GLB 实际渲染，缩放画布并等待刷新后拍摄，不是概念生图。

这些是本机浏览器的结构、视觉与简单动作验证，不等同于 iPhone/iPad 真机性能验收或孩子最终审美认可。主角与狐狸向导、八伙伴同场的摆放与点击，由运行场景的验收另行覆盖。

## 重建

在已有 Blender 的 Mac 上执行：

```sh
/path/to/Blender --background --python tools/build_child.py -- --output assets/models
node design/check-child-model.cjs
node design/render-child.cjs
```

最后一条需要开发机已有 Playwright、Chrome 及本地静态服务，默认地址 `http://127.0.0.1:4173`；这些制作与检查工具不是网站的运行依赖。
