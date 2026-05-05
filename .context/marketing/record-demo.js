#!/usr/bin/env node
/**
 * Playwright script to record kiwimu v1.1 demo GIF.
 *
 * Usage:
 *   node .context/marketing/record-demo.js
 *
 * Prerequisites:
 *   - Playwright installed (npx playwright install chromium)
 *   - kiwimu dev server NOT running (script starts its own)
 *   - ffmpeg available for GIF conversion
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

  // Start kiwimu dev server
  console.log('🚀 Starting kiwimu dev server...');
  const { spawn } = await import('child_process');
  const server = spawn('bun', ['run', 'src/index.ts', 'init', '--demo'], {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'development', KIWI_PORT: String(PORT) }
  });

  // Wait for server to be ready
  let serverReady = false;
  server.stdout.on('data', (data) => {
    const text = data.toString();
    if (text.includes('준비되었습니다') || text.includes('localhost:8000')) {
      serverReady = true;
    }
  });
  server.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('준비되었습니다') || text.includes('localhost:8000')) {
      serverReady = true;
    }
  });

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

  // Navigate to BST page
  console.log('📄 Loading BST page...');
  await page.goto(`${BASE}/wiki/이진탐색트리.html`, { waitUntil: 'networkidle' });
  await captureFrame(page, 'page-loaded', 1000);

  // --- Step 1: User drags "회전(rotation)" ---
  console.log('🔍 Selecting text...');

  // Find the text "회전(rotation)" in the page body
  const pageBody = page.locator('.page-body');
  const targetText = pageBody.locator('text=회전(rotation)');
  const box = await targetText.boundingBox();

  if (!box) {
    console.error('❌ Could not find "회전(rotation)" text');
    await browser.close();
    server.kill();
    process.exit(1);
  }

  // Simulate mouse drag selection
  const startX = box.x + 2;
  const startY = box.y + box.height / 2;
  const endX = box.x + box.width - 2;
  const endY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Slow drag for natural feel
  for (let step = 0; step <= 10; step++) {
    const x = startX + (endX - startX) * (step / 10);
    await page.mouse.move(x, startY);
    await sleep(30);
  }
  await page.mouse.up();

  // Wait for popover (500ms delay in dynamic-qa.js)
  await captureFrame(page, 'text-selected', 200);
  await sleep(600);

  // --- Step 2: Popover appears ---
  console.log('💬 Popover appeared...');
  await captureFrame(page, 'popover-visible', 300);

  // --- Step 3: User types question ---
  console.log('⌨️  Typing question...');
  const input = page.locator('.qa-popover-input');
  await input.click();
  await sleep(200);

  // Type character by character for natural feel
  const question = '어떻게 균형을 유지하나요?';
  for (const char of question) {
    await input.type(char, { delay: 80 });
  }
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
    // Create palette for better quality
    execSync(
      `ffmpeg -y -framerate 2 -i ${OUT_DIR}/%04d_.png -vf "fps=2,scale=1280:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer" ${GIF_OUT}`,
      { stdio: 'inherit' }
    );
    console.log(`\n🎉 GIF saved to: ${GIF_OUT}`);
  } catch (e) {
    console.error('⚠️  ffmpeg GIF conversion failed. Frames are in:', OUT_DIR);
    console.error('   Manual conversion:');
    console.error(`   ffmpeg -framerate 2 -i ${OUT_DIR}/%04d_.png -vf "fps=2,scale=1280:-1:flags=lanczos" ${GIF_OUT}`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});