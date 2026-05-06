#!/usr/bin/env node
/**
 * Playwright script to record kiwimu v1.1 demo GIF.
 *
 * Usage:
 *   bun add -d playwright && bunx playwright install chromium
 *   node .context/marketing/record-demo.js
 *
 * Prerequisites:
 *   - Playwright installed (npx playwright install chromium)
 *   - port 8001 free (script starts its own server here)
 *   - ffmpeg available for GIF conversion
 *
 * Note: this is a fallback automated recorder. The launch path is
 * CleanShot X for real-time 30fps capture; Playwright at fps=2
 * produces a slideshow-style GIF, useful for previews not viral SNS.
 *
 * Output:
 *   .context/marketing/frames/  — individual PNG frames
 *   .context/marketing/demo.gif — final 30s GIF
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..');
const OUT_DIR = join(import.meta.dir, 'frames');
const GIF_OUT = join(import.meta.dir, 'demo.gif');
const PORT = 8001; // Avoid conflict with OrbStack on 8000
const BASE = `http://localhost:${PORT}`;
const WORKSPACE = '/tmp/kiwimu-record-workspace';

// --- Mock API responses ---

const MOCK_ASK_RESULT = {
  ok: true,
  url: '/wiki/트리-회전.html',
  title: '트리 회전 (Tree Rotation)',
  content: `## 트리 회전 (Tree Rotation)

트리 회전은 이진 탐색 트리의 균형을 유지하기 위한 핵심 연산입니다.

### AVL 트리에서의 회전

AVL 트리에서는 각 노드의 왼쪽과 오른쪽 서브트리 높이 차이(균형 인수)가 최대 1이 되도록 회전을 수행합니다.

- **단일 회전 (Single Rotation)**: LL 회전, RR 회전
- **이중 회전 (Double Rotation)**: LR 회전, RL 회전

### 시간 복잡도

회전 연산은 $O(1)$ 시간에 수행됩니다. 트리 전체 재조합 없이 포인터만 변경하면 되기 때문입니다.

> 트리 회전은 불변식(invariant)을 유지하면서 트리의 높이를 줄이는 것이 목적입니다.`,
  suggestedTitle: '트리 회전 (Tree Rotation)',
  isPromotable: true,
  sourcePageId: 4,
  selectedText: '회전(rotation) 연산을 통해',
  question: '어떻게 균형을 유지하나요?'
};

const MOCK_PROMOTE_RESULT = {
  ok: true,
  url: '/wiki/트리-회전.html',
  title: '트리 회전 (Tree Rotation)',
  slug: '트리-회전',
  updated: false
};

const MOCK_SEARCH_RESULT = {
  results: [
    { slug: '이진탐색트리', title: '이진탐색트리', origin: 'source', page_type: 'source', preview: '이진탐색트리는 왼쪽 자식 < 부모 < 오른쪽 자식 규칙을 따르는 자료구조입니다.' }
  ]
};

// --- Helpers ---

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function captureFrame(page, name, delayMs = 0) {
  if (delayMs > 0) await sleep(delayMs);
  const frameNum = String(readdirSync(OUT_DIR).length).padStart(4, '0');
  const path = join(OUT_DIR, `${frameNum}_${name}.png`);
  await page.screenshot({ path, fullPage: false });
  console.log(`  📸 ${frameNum}_${name}.png`);
  return path;
}

// --- Main ---

async function main() {
  console.log('🥝 kiwimu v1.1 demo recording\n');

  // Clean output directory
  mkdirSync(OUT_DIR, { recursive: true });
  for (const f of readdirSync(OUT_DIR)) {
    const fs = await import('fs');
    fs.unlinkSync(join(OUT_DIR, f));
  }

  // Wipe + recreate workspace so `init --demo` runs non-interactively.
  // `init --demo` does setup AND auto-starts the server on KIWI_PORT — so it is the server.
  console.log('🛠  Bootstrapping demo workspace at', WORKSPACE);
  const fsSync = await import('fs');
  fsSync.rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });

  console.log('🚀 Starting kiwimu init+serve on port', PORT);
  const { spawn } = await import('child_process');
  const server = spawn('bun', ['run', join(ROOT, 'src/index.ts'), 'init', '--demo'], {
    cwd: WORKSPACE,
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'development', KIWI_PORT: String(PORT) }
  });

  // Server is ready when the banner mentions our PORT (init prints "http://localhost:<PORT>")
  // Also capture the auth token: the dynamic-qa.js feature self-disables without it.
  let serverReady = false;
  let authToken = null;
  const readinessMarker = (text) => text.includes(`localhost:${PORT}`);
  const tokenMatcher = /인증 토큰:\s*([0-9a-f-]{36})/;
  const handleServerOutput = (t, isErr) => {
    (isErr ? process.stderr : process.stdout).write(`  [server${isErr ? '-err' : ''}] ${t}`);
    if (readinessMarker(t)) serverReady = true;
    const m = t.match(tokenMatcher);
    if (m) authToken = m[1];
  };
  server.stdout.on('data', (data) => handleServerOutput(data.toString(), false));
  server.stderr.on('data', (data) => handleServerOutput(data.toString(), true));

  // Wait up to 30s for server
  for (let i = 0; i < 60; i++) {
    if (serverReady) break;
    await sleep(500);
  }
  if (!serverReady) {
    console.error('❌ Server failed to start within 30s');
    server.kill();
    process.exit(1);
  }
  console.log('✅ Server ready\n');

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--window-size=1280,800']
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();

  // Mock API routes
  await page.route('**/api/ask', async (route) => {
    if (route.request().method() === 'POST') {
      // Return a task_id first, then the status endpoint returns the result
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ task_id: 'demo-task-001' })
      });
    } else {
      await route.continue();
    }
  });

  await page.route('**/api/ask/status*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'completed',
        result: MOCK_ASK_RESULT
      })
    });
  });

  await page.route('**/api/promote', async (route) => {
    await sleep(800); // Simulate processing time
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_PROMOTE_RESULT)
    });
  });

  await page.route('**/api/search*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_SEARCH_RESULT)
    });
  });

  if (!authToken) {
    console.error('❌ Could not capture auth token from server output');
    await browser.close();
    server.kill();
    process.exit(1);
  }
  console.log('🔑 Auth token:', authToken.slice(0, 8) + '…');

  // Navigate to BST page WITH auth token — the dynamic-qa popover only mounts
  // when the kiwi-auth meta tag is present, which the server only injects
  // for authenticated requests. ?token= also sets a cookie for follow-ups.
  console.log('📄 Loading BST page...');
  await page.goto(`${BASE}/wiki/이진탐색트리.html?token=${authToken}`, { waitUntil: 'networkidle' });
  await captureFrame(page, 'page-loaded', 1000);

  // --- Step 1: Programmatically select "회전(rotation)" ---
  // Headless mouse drag doesn't reliably populate window.getSelection() across
  // browsers, so we set the Range directly and fire mouseup to trigger the popover.
  console.log('🔍 Selecting text...');
  const TARGET = '회전(rotation)';
  const ok = await page.evaluate((target) => {
    const root = document.querySelector('.page-body');
    if (!root) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const idx = node.textContent.indexOf(target);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + target.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        // The popover listens on document mouseup
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, TARGET);

  if (!ok) {
    console.error(`❌ Could not find "${TARGET}" text in .page-body`);
    await browser.close();
    server.kill();
    process.exit(1);
  }

  await captureFrame(page, 'text-selected', 200);
  // Popover has a 500ms delay in dynamic-qa.js, then we want it visible
  await sleep(700);

  // --- Step 2: Popover appears ---
  console.log('💬 Popover appeared...');
  await captureFrame(page, 'popover-visible', 300);

  // --- Step 3: User types question ---
  // input.type() simulates physical keypresses which don't compose Korean Hangul.
  // fill() sets the value directly and fires the input event — works for any script.
  console.log('⌨️  Typing question...');
  const input = page.locator('.qa-popover-input');
  await input.waitFor({ state: 'visible', timeout: 10000 });
  await input.click();
  await sleep(200);
  const question = '어떻게 균형을 유지하나요?';
  await input.fill(question);
  await captureFrame(page, 'question-typed', 300);

  // --- Step 4: Click generate ---
  console.log('✨ Generating concept page...');
  await page.locator('.qa-generate-btn').click();
  await captureFrame(page, 'generating', 200);

  // Wait for "completed" result (polling interval is 2s, but mock is instant)
  await sleep(2500);
  await captureFrame(page, 'result-ready', 300);

  // --- Step 5: Click "위키에 저장" ---
  console.log('💾 Saving to wiki...');
  const promoteBtn = page.locator('.qa-promote-btn');
  if (await promoteBtn.isVisible()) {
    await promoteBtn.click();
    await captureFrame(page, 'saving', 200);

    // Wait for toast animation
    await sleep(1500);
    await captureFrame(page, 'toast-visible', 500);

    // Wait for sidebar update
    await sleep(500);
    await captureFrame(page, 'sidebar-updated', 1000);
  }

  // --- Final frame ---
  await captureFrame(page, 'final', 500);

  console.log('\n✅ Frames captured!');

  // Close browser and server
  await browser.close();
  server.kill();

  // Convert frames to GIF using ffmpeg
  console.log('\n🎬 Converting to GIF...');
  try {
    // Frames are named like 0000_page-loaded.png — glob picks them up in order.
    // Palette pass produces a much smaller, smoother GIF.
    execSync(
      `ffmpeg -y -framerate 2 -pattern_type glob -i '${OUT_DIR}/*.png' -vf "fps=2,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" ${GIF_OUT}`,
      { stdio: 'inherit' }
    );
    console.log(`\n🎉 GIF saved to: ${GIF_OUT}`);
  } catch (e) {
    console.error('⚠️  ffmpeg GIF conversion failed. Frames are in:', OUT_DIR);
    console.error('   Manual conversion:');
    console.error(`   ffmpeg -framerate 2 -pattern_type glob -i '${OUT_DIR}/*.png' -vf "fps=2,scale=1280:-1:flags=lanczos" ${GIF_OUT}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});