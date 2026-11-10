import animation from "./en-US/animation";
import canvas from "./en-US/canvas";
import canvasLayers from "./en-US/canvasLayers";
import chat from "./en-US/chat";
import chatComposer from "./en-US/chatComposer";
import common from "./en-US/common";
import editors from "./en-US/editors";
import editorsDialogs from "./en-US/editorsDialogs";
import gallery from "./en-US/gallery";
import misc from "./en-US/misc";
import miscData from "./en-US/miscData";
import miscLib from "./en-US/miscLib";
import queue from "./en-US/queue";
import retouch from "./en-US/retouch";
import settings from "./en-US/settings";
import settingsSections from "./en-US/settingsSections";
import shell from "./en-US/shell";

/// 分片聚合：各区域的译文放在 en-US/<area>.ts，避免多人/多批迁移时互相冲突。
const enUS = {
  ...common,
  ...settings,
  ...shell,
  ...chat,
  ...chatComposer,
  ...gallery,
  ...queue,
  ...editors,
  ...retouch,
  ...editorsDialogs,
  ...settingsSections,
  ...canvas,
  ...canvasLayers,
  ...animation,
  ...misc,
  ...miscLib,
  ...miscData,
} as const;

export default enUS;
