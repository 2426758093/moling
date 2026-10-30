import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MessageItem from "./MessageItem";
import { useChatStore, type DisplayMessage } from "../stores/chatStore";

const baseMessage: Omit<DisplayMessage, "id" | "content"> = {
  role: "assistant",
  refined: "",
  thinkingUsed: false,
  attachments: [],
  images: [],
  pendingImages: 0,
  status: "done",
  error: null,
};

beforeEach(() => {
  useChatStore.setState({ sending: false, activeId: 7, messages: [] });
});

describe("MessageItem 的重试目标（F-009）", () => {
  it("错误态点击重试时传被点击消息的 id", () => {
    const retryLast = vi.fn(async () => undefined);
    useChatStore.setState({ retryLast });

    render(
      <MessageItem
        message={{
          ...baseMessage,
          id: 4,
          content: "第二轮失败",
          status: "error",
          error: { type: "network", message: "boom" },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(retryLast).toHaveBeenCalledWith(4);
  });

  it("停止态点击重试时同样传消息 id", () => {
    const retryLast = vi.fn(async () => undefined);
    useChatStore.setState({ retryLast });

    render(
      <MessageItem
        message={{
          ...baseMessage,
          id: 8,
          content: "被停止的回复",
          status: "stopped",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    expect(retryLast).toHaveBeenCalledWith(8);
  });
});
