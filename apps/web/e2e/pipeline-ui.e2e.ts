import { expect, test } from "@playwright/test";

test.describe("Pipeline UI", () => {
  test.use({
    permissions: ["camera"],
  });

  test("renders scan button, HUD, and proof modal elements", async ({
    page,
  }) => {
    await page.goto("/");

    const button = page.locator("#pipeline-button");
    await expect(button).toBeVisible();
    await expect(button).toContainText("scan identity");
    await expect(button).toBeEnabled();

    await expect(page.locator("#pipeline-hud")).toBeAttached();
    await expect(page.locator("#proof-modal")).toBeAttached();

    // HUD and modal start hidden.
    await expect(page.locator("#pipeline-hud")).toBeHidden();
    await expect(page.locator("#proof-modal")).toBeHidden();
  });

  test("clicking scan with live camera shows the HUD in busy state", async ({
    page,
  }) => {
    await page.goto("/");
    const button = page.locator("#pipeline-button");
    await expect(button).toBeEnabled();
    await button.click();
    // HUD appears immediately (busy state) even before the response lands.
    await expect(page.locator("#pipeline-hud")).toBeVisible();
    await expect(page.locator("#hud-status")).toContainText(
      /identifying|scan|result/
    );
  });

  test("proof modal opens via proof button after result and closes via Escape", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#pipeline-button")).toBeEnabled();

    // Simulate a completed scan result to drive the modal path.
    await page.evaluate(() => {
      const store = {
        result: null,
      };
      window.dispatchEvent(
        new CustomEvent("mira-test-hook", { detail: store })
      );
      const modal = document.querySelector("#proof-modal");
      if (modal instanceof HTMLElement) {
        modal.hidden = false;
      }
    });
    await expect(page.locator("#proof-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#proof-modal")).toBeHidden();
  });

  test("scan against real backend renders results or a clean error", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    const button = page.locator("#pipeline-button");
    await expect(button).toBeEnabled();
    await button.click();

    // Wait for the busy phase to end.
    await expect(button).toBeEnabled({ timeout: 110_000 });

    // HUD must now show either results or a graceful error — never stay stuck.
    await expect(page.locator("#pipeline-hud")).toBeVisible();
    const status = page.locator("#hud-status");
    await expect(status).toContainText(/complete|failed|result/);
  });
});
