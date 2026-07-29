# Word 版本的生成流程（可重复执行）

`SKEQI_AI_Email_Drafter_项目规划书.docx` 由同目录的 Markdown 原稿自动生成，流程如下。

## 依赖

| 工具 | 用途 | 获取方式 |
| --- | --- | --- |
| pandoc 3.10+ | Markdown → docx | 便携版即可，无需系统安装 |
| @mermaid-js/mermaid-cli | Mermaid → PNG | `PUPPETEER_SKIP_DOWNLOAD=1 npm i @mermaid-js/mermaid-cli`，复用本机已安装的 Chrome |
| @napi-rs/canvas | 超高图片切片 | 项目 `node_modules` 内已有 |

## 步骤

1. `render_diagrams.py` — 抽取 Markdown 中的 14 个 mermaid 代码块，逐个渲染为 `../diagrams/diagram-NN.png`（2× 缩放、白底）。
2. `reflow.py` — 对宽高比过大的流程图改用纵向布局重渲染，避免在 A4 上被压缩到不可读。
3. `slice.js` — 把超高截图（宽高比 < 0.60）按页面比例纵向切片到 `../screenshots/split/`，每片带 60px 重叠，使其能以整页宽度呈现而非被缩小。
4. `build_docx.py` — 组装最终 docx：
   - 用图片替换 mermaid 代码块，并按页面可用区域计算每张图的宽度；
   - 宽高比 > 2.4 的图自动放到**横向页面**（注入 OpenXML 分节符）；
   - 超高截图展开为多张「第 N/M 部分」整页宽图片；
   - 删除手写目录，改用 Word 原生可更新目录域；
   - 生成 reference.docx：A4、2cm 页边距、正文 宋体 10.5pt、标题 微软雅黑、代码 Consolas 8.5pt、表格 9pt。

## 重新生成

```bash
python3 render_diagrams.py && python3 reflow.py
node slice.js > /tmp/slices.json     # build_docx.py 会读取该清单
python3 build_docx.py
```

> 脚本中的路径为绝对路径，迁移目录后需同步修改顶部常量。
