import { execFileSync } from "node:child_process";

const APP_IMAGE = "moling.exe";

/** tasklist 是 Windows 自带命令；返回 false 也覆盖了「进程已退出」的正常情况 */
function isAppRunning(): boolean {
  try {
    const output = execFileSync(
      "tasklist",
      ["/FI", `IMAGENAME eq ${APP_IMAGE}`, "/NH"],
      { encoding: "utf8" },
    );
    return output.toLowerCase().includes(APP_IMAGE);
  } catch {
    return false;
  }
}

describe("墨灵 MoLing 冒烟", () => {
  it("启动后窗口标题包含「墨灵」", async () => {
    await browser.waitUntil(async () => (await browser.getTitle()).length > 0, {
      timeout: 30000,
      timeoutMsg: "窗口在 30s 内未返回标题",
    });

    const title = await browser.getTitle();
    expect(title).toContain("墨灵");
  });

  it("关闭窗口后应用进程退出", async () => {
    await browser.deleteSession();

    let running = true;
    for (let attempt = 0; attempt < 40 && running; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      running = isAppRunning();
    }

    expect(running).toBe(false);
  });
});
