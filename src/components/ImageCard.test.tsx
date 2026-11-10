import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "./ui/Tooltip";
import ImageCard from "./ImageCard";
import { useAppStore } from "../stores/appStore";
import { useChatStore, type ChatImage } from "../stores/chatStore";
import { useProviderStore } from "../stores/providerStore";

const image: ChatImage = {
  historyId: 21,
  dataUrl: "data:image/png;base64,SAME",
  path: "C:/media/same.png",
  prompt: "一只猫",
  seed: null,
};

beforeEach(() => {
  useAppStore.setState({
    view: "chat",
    canvasInline: true,
    retouchTarget: null,
    mode: "expert",
  });
  useChatStore.setState({ activeId: 7, messages: [] });
  // 没有服务商 = 全部按默认能力：修图入口一定渲染
  useProviderStore.setState({ providers: [], defaultProviderId: null });
});

/// ImageCard 渲染在聊天里：修图台关闭后必须回到聊天，而不是写死画廊
describe("ImageCard 修图入口", () => {
  it("从聊天打开修图台时 returnView 跟随当前视图", () => {
    render(
      <TooltipProvider>
        <ImageCard
          image={image}
          siblings={[image]}
          prompt="一只猫"
          messageId={3}
        />
      </TooltipProvider>,
    );

    fireEvent.click(
      document.querySelector('[aria-label="修图"]') as HTMLElement,
    );

    const state = useAppStore.getState();
    expect(state.view).toBe("retouch");
    expect(state.retouchTarget?.historyId).toBe(21);
    expect(state.retouchTarget?.returnView).toBe("chat");

    useAppStore.getState().closeRetouch();
    expect(useAppStore.getState().view).toBe("chat");
  });
});
