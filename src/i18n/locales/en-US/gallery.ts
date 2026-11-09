/// 画廊：筛选条、栅格操作、空态与导出反馈。
/// key 是中文原文，value 是英文译文；缺失的 key 在英文下会回退中文。
/// 注意：含中文标点或插值的 key 必须写成带引号的字符串。
const gallery = {
  // GalleryView · 页头与筛选
  画廊: "Gallery",
  "{{n}} 张作品": "{{n}} works",
  全部模型: "All models",
  按模型筛选: "Filter by model",
  全部风格: "All styles",
  按风格筛选: "Filter by style",
  收藏筛选: "Favorite filter",
  全部: "All",
  只看收藏: "Favorites only",
  刷新: "Refresh",

  // GalleryView · 空态与加载
  加载画廊失败: "Couldn't load gallery",
  重试: "Retry",
  还没有收藏的作品: "No favorites yet",
  还没有生成记录: "No generations yet",
  在聊天里生成图片后点星标即可收藏:
    "Generate an image in chat, then tap the star to save it",
  "回到聊天描述一个画面，生成结果会自动归档到这里":
    "Head back to chat, describe a scene, and results land here automatically",
  缩略图生成中: "Generating thumbnail",
  加载更多失败: "Couldn't load more",
  加载更多: "Load more",
  "加载中…": "Loading…",
  更早: "Earlier",
  "{{n}} 张": "{{n}} images",

  // GalleryView · 作品操作
  "选择作品：{{prompt}}": "Select work: {{prompt}}",
  取消收藏: "Remove from favorites",
  收藏该作品: "Add to favorites",
  "派生 #{{id}}": "Derived #{{id}}",
  复用参数: "Reuse parameters",
  加入画布: "Add to canvas",
  收藏提示词: "Save prompt",
  下载原图与参数: "Download original with parameters",
  删除: "Delete",

  // GalleryView · 选择工具条
  "已选 {{n}}": "{{n}} selected",
  对比: "Compare",
  "打包导出已选 {{n}} 张作品": "Export {{n}} selected works as ZIP",
  "打包中…": "Packaging…",
  导出: "Export",
  取消选择: "Clear selection",

  // GalleryView · 提示
  已保存图片: "Image saved",
  "收藏操作失败，请稍后重试": "Couldn't update favorite. Try again later",
  "删除失败，请稍后重试": "Delete failed. Try again later",
  "已导出 {{saved}} 张，{{skipped}} 张因缺图被跳过":
    "Exported {{saved}} images; skipped {{skipped}} with missing originals",
  "已导出 {{n}} 张": "Exported {{n}} images",
  "打包导出失败，请重试": "ZIP export failed. Try again",
  该作品没有可收藏的提示词: "This work has no prompt to save",
  已收藏提示词: "Prompt saved",
  "该提示词已存在，已更新收藏": "Prompt already saved; favorite updated",
  该作品已在画布中: "Already on canvas",
  已加入画布: "Added to canvas",
  "下载失败：原图不可用": "Download failed: original unavailable",
} as const;

export default gallery;
