/**
 * Record an animated demo of Copilot Uplink for the README.
 *
 * Usage:
 *   1. Start the dev server:  npm run dev
 *   2. Run this script:       npx tsx scripts/record-demo.ts
 *   3. Convert to GIF:        ffmpeg -i docs/demo.webm -vf "fps=20,scale=390:-1" -loop 0 docs/demo.gif
 *
 * The script launches a headless Chromium at mobile viewport (390x844, dark mode),
 * walks through a realistic interaction, and saves a WebM to docs/demo.webm.
 *
 * Prompt keywords recognised by the mock agent:
 *   "tool ..."       -> tool call lifecycle (read/edit/execute icons + status)
 *   "reason ..."     -> thinking tokens then recommendation
 *   "thinking ..."   -> shorter thinking then answer
 *   "plan ..."       -> plan entries with priority/status
 *   "permission ..." -> permission approve/deny prompt
 *   "stream ..."     -> multi-chunk streaming
 *   (anything else)  -> simple text response
 */

import { chromium, type Locator } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    recordVideo: { dir: "docs/", size: { width: 390, height: 844 } },
  });

  const page = await context.newPage();
  await page.goto(BASE_URL);
  await page.getByText("ready").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(1000);

  // -- Scene 1: Send a prompt that triggers thinking --
  const input = page.locator("#prompt-input");
  await typeSlowly(input, "reasoning about how to fix the bug", 60);
  await page.waitForTimeout(400);
  await page.locator("#send-btn").click();

  // Wait for thinking to appear, then for response to finish
  await page.locator(".tool-call-thinking").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.locator("#send-btn:not([hidden])").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(1000);

  // -- Scene 2: Send a prompt with tool calls --
  await typeSlowly(input, "tool call to read and edit files", 50);
  await page.waitForTimeout(300);
  await page.locator("#send-btn").click();
  await page.locator(".tool-call").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.locator("#send-btn:not([hidden])").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(1200);

  // -- Scene 3: Show model palette --
  await typeSlowly(input, "/model ", 80);
  await page.waitForTimeout(1500);

  // -- Scene 4: Show plan mode border preview --
  await input.fill("");
  await page.waitForTimeout(300);
  await typeSlowly(input, "/plan ", 80);
  await page.waitForTimeout(1500);

  // Clean up
  await input.fill("");
  await page.waitForTimeout(500);

  // Close context to flush video
  await context.close();
  await browser.close();

  // Playwright saves video as a random hex name -- find it
  const fs = await import("fs");
  const files = fs.readdirSync("docs").filter((f: string) => f.endsWith(".webm"));
  if (files.length === 1) {
    fs.renameSync(`docs/${files[0]}`, "docs/demo.webm");
    console.log("Saved docs/demo.webm");
  } else {
    console.log("WebM files in docs/:", files);
    console.log("Rename the latest one to docs/demo.webm");
  }
}

async function typeSlowly(locator: Locator, text: string, delayMs: number) {
  await locator.pressSequentially(text, { delay: delayMs });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
