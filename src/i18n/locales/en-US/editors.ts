/// 编辑器：局部重绘、扩图、换背景、基础编辑、风格转换、蒙版。
const editors = {
  // 局部重绘 / AI 消除（EditorView）
  请输入重绘描述: "Enter a description to repaint",
  "请先在「设置」中配置服务商": "Add a provider in Settings first",
  "请先在「设置」中选择默认模型": "Choose a default model in Settings first",
  请先涂抹要修改的区域: "Paint the area to change first",
  "（AI 消除）": "(AI erase)",
  "{{title}}：{{message}}": "{{title}}: {{message}}",
  "AI 消除": "AI Erase",
  局部重绘: "Inpaint",
  "点击要修改的物体自动选中；Shift 加选、Alt 减选，可继续用画笔修整":
    "Click an object to select it; Shift adds, Alt subtracts, then refine with the brush",
  "涂抹要消除的对象，一键补全背景":
    "Paint over the object to remove and the background fills in",
  "涂抹要修改的区域，其余像素保持不变":
    "Paint the area to change; everything else stays untouched",
  一键消除: "Erase",
  关闭编辑器: "Close editor",
  蒙版工具: "Mask tools",
  画笔大小: "Brush size",
  关闭橡皮擦: "Turn off eraser",
  橡皮擦: "Eraser",
  "AI 识别物体：点击选中，Shift 加选，Alt 减选":
    "AI object select: click to select, Shift to add, Alt to subtract",
  点选物体: "Pick object",
  全选: "Select all",
  清除蒙版: "Clear mask",
  "描述要重绘的内容…": "Describe what to repaint…",
  重绘描述: "Repaint description",
  重绘结果: "Repaint result",
  继续编辑: "Keep editing",
  "完成，返回画布": "Done, back to canvas",
  "完成，返回对话": "Done, back to chat",
  编辑对象: "Edit source",
  "加载中…": "Loading…",

  // 换背景（BackgroundView）
  换背景: "Replace background",
  "涂抹要替换的背景区域，也可先「自动选中背景」再修整":
    "Paint the background to replace, or use Auto-select background and refine",
  关闭换背景: "Close background editor",
  换背景工具: "Background tools",
  全选背景: "Select all background",
  "本地 AI 识别主体，自动选中主体之外的背景":
    "Detect the subject locally and select everything around it",
  自动选中背景: "Auto-select background",
  清除: "Clear",
  背景类型: "Background type",
  纯色: "Solid",
  渐变: "Gradient",
  "AI 描述": "AI prompt",
  背景颜色: "Background color",
  起始颜色: "Start color",
  结束颜色: "End color",
  渐变方向: "Gradient direction",
  水平: "Horizontal",
  垂直: "Vertical",
  对角: "Diagonal",
  "描述想要的背景，例如：星空下的霓虹城市…":
    "Describe the background, e.g. a neon city under the stars…",
  背景描述: "Background description",
  "没有识别到可替换的背景，请手动涂抹":
    "No background found to replace; paint it manually",
  "主体不明显，已选中几乎整张图，请用橡皮擦修正":
    "Subject unclear: almost the whole image got selected. Fix it with the eraser",
  请先涂抹要替换的背景区域: "Paint the background area to replace first",
  换背景结果: "Background result",
  继续调整: "Keep adjusting",
  换背景对象: "Background source",
  "换背景：{{desc}}": "Background: {{desc}}",
  "换背景：纯色": "Background: solid",
  "换背景：渐变": "Background: gradient",

  // 基础编辑（BasicEditView）
  基础编辑: "Basic edit",
  "裁剪、旋转、翻转与调色全在本地完成，不消耗接口额度":
    "Crop, rotate, flip and color adjustments run locally and use no API credits",
  应用编辑: "Apply",
  基础编辑工具: "Basic edit tools",
  "左转 90°": "Rotate left 90°",
  "右转 90°": "Rotate right 90°",
  取消水平翻转: "Turn off horizontal flip",
  水平翻转: "Flip horizontally",
  取消垂直翻转: "Turn off vertical flip",
  垂直翻转: "Flip vertically",
  全图: "Whole image",
  亮度: "Brightness",
  对比度: "Contrast",
  饱和度: "Saturation",
  重置色彩: "Reset color",
  还没有任何改动: "Nothing changed yet",
  "输出 {{w}} × {{h}}": "Output {{w}} × {{h}}",
  "在图上拖拽框选裁剪区域，拖动角点可微调":
    "Drag on the image to choose the crop area; drag a corner to fine-tune",

  // 扩图（OutpaintView）
  扩图: "Outpaint",
  "向外拖动手柄扩展画面，AI 补全内容":
    "Drag the handles outward to expand the frame; AI fills in the rest",
  生成扩图: "Generate",
  关闭扩图: "Close outpaint",
  扩图工具: "Outpaint tools",
  目标比例: "Aspect ratio",
  "补充描述（可选）：如“延伸出海面与晚霞”":
    'Optional prompt, e.g. "extend into the sea and sunset"',
  补全描述: "Outpaint description",
  扩图对象: "Outpaint source",
  "（扩图 {{w}}×{{h}}）": "(outpaint {{w}}×{{h}})",
  自由: "Free",
  上: "top",
  右: "right",
  下: "bottom",
  左: "left",
  "向{{side}}扩图": "Expand {{side}}",
} as const;

export default editors;
