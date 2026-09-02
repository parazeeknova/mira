// oxlint-disable require-await
import { expect, test } from "@playwright/test";

const MOCK_RESULT = {
  anchorStrategy: "search",
  blockchain: {
    blockNumber: 2,
    contentHash: "a".repeat(64),
    explorerUrl: "https://amoy.polygonscan.com/tx/0xabc",
    storedAt: 1,
    txHash: `0x${"b".repeat(64)}`,
  },
  blockchainError: null,
  cacheHit: false,
  duplicate: false,
  enginesUsed: ["google-vision"],
  error: null,
  face: { bbox: { height: 80, width: 70, x: 10, y: 20 }, confidence: 0.9 },
  inputFaceHash: "c".repeat(64),
  results: [
    {
      engine: "google-vision",
      fetchedAt: 1,
      finalScore: 1.1,
      imageUrl: null,
      multiSourceCount: 1,
      platform: "linkedin",
      similarity: 0.9,
      snippet: "engineer at example corp",
      sourceStrategy: "google-vision",
      title: "Example Person — Software Engineer",
      url: "https://example.com/post",
    },
  ],
  verified: true,
};

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
    await expect(button).toContainText(/scan identity|rescan/u);
    await expect(button).toBeEnabled();

    await expect(page.locator("#pipeline-hud")).toBeAttached();
    await expect(page.locator("#proof-modal")).toBeAttached();

    // HUD and modal start hidden.
    await expect(page.locator("#pipeline-hud")).toBeHidden();
    await expect(page.locator("#proof-modal")).toBeHidden();
  });

  test("auto-triggers a scan when a face track stabilizes (zero-click)", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.route("**/api/pipeline", async (route) => {
      await route.fulfill({ json: MOCK_RESULT });
    });

    await page.goto("/");

    // Fake camera + tracking produces a stable trackId after ~1s; the client
    // must auto-fire the pipeline without any click.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelector<HTMLElement>("#pipeline-hud")?.hidden ===
              false
          ),
        { intervals: [500], timeout: 60_000 }
      )
      .toBe(true);

    await expect(page.locator("#hud-status")).toContainText(/complete|result/u);
    await expect(page.locator(".result-card")).toHaveCount(1);
    await expect(page.locator("#hud-verified-badge")).toContainText("verified");
    // Busy state cleared.
    await expect(page.locator("#pipeline-button")).toBeEnabled();
  });

  test("manual rescan button drives the same flow and shows results", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.route("**/api/pipeline", async (route) => {
      await route.fulfill({ json: MOCK_RESULT });
    });

    await page.goto("/");
    const button = page.locator("#pipeline-button");
    // Let any auto-trigger finish first.
    await expect(button).toBeEnabled({ timeout: 60_000 });
    await expect
      .poll(async () => await button.getAttribute("data-busy"), {
        intervals: [300],
        timeout: 30_000,
      })
      .toBe("false");

    await button.click();
    await expect(page.locator("#pipeline-hud")).toBeVisible();
    await expect(page.locator(".result-card")).toHaveCount(1);
    await expect(page.locator("#hud-status")).toContainText(/complete|result/u);
    await expect(button).toBeEnabled({ timeout: 30_000 });
  });

  test("renders the on-chain proof modal with hash and tx details", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.route("**/api/pipeline", async (route) => {
      await route.fulfill({ json: MOCK_RESULT });
    });

    await page.goto("/");
    // Wait for the auto-trigger to complete, then open the proof modal.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelectorAll(".result-card").length > 0 &&
              (document.querySelector("#pipeline-button") as HTMLButtonElement)
                ?.disabled === false
          ),
        { intervals: [500], timeout: 60_000 }
      )
      .toBe(true);

    await page.click("#hud-proof-button");
    await expect(page.locator("#proof-modal")).toBeVisible();
    await expect(page.locator("#proof-status")).toContainText("verified");
    await expect(page.locator("#proof-content-hash")).toContainText("a");
    await expect(page.locator("#proof-engines")).toContainText("google-vision");
    await expect(page.locator("#proof-url")).toContainText("example.com");

    await page.keyboard.press("Escape");
    await expect(page.locator("#proof-modal")).toBeHidden();
  });

  test("shows a graceful error card when the scan fails", async ({ page }) => {
    test.setTimeout(90_000);
    await page.route("**/api/pipeline", async (route) => {
      await route.fulfill({
        json: {
          ...MOCK_RESULT,
          blockchain: null,
          error: "No face detected in image.",
          results: [],
          verified: false,
        },
      });
    });

    await page.goto("/");
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelector<HTMLElement>("#pipeline-hud")?.hidden ===
              false
          ),
        { intervals: [500], timeout: 60_000 }
      )
      .toBe(true);

    await expect(page.locator("#hud-status")).toContainText(/failed/u);
    await expect(page.locator("#hud-results")).toContainText(
      "No face detected"
    );
  });

  test("cache hit shows the instant badge", async ({ page }) => {
    test.setTimeout(90_000);
    await page.route("**/api/pipeline", async (route) => {
      await route.fulfill({
        json: { ...MOCK_RESULT, cacheHit: true },
      });
    });

    await page.goto("/");
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              document.querySelector<HTMLElement>("#pipeline-hud")?.hidden ===
              false
          ),
        { intervals: [500], timeout: 60_000 }
      )
      .toBe(true);

    await expect(page.locator("#hud-cache-badge")).toContainText("instant");
  });
});
