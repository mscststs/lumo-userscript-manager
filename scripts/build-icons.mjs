#!/usr/bin/env node
/**
 * Regenerates `public/icon/*.png` from `assets/logo.svg`.
 *
 * Uses headless Chrome/Chromium as a dependency-free SVG rasterizer so the
 * committed toolbar icons can always be reproduced from the vector source.
 *
 * Usage:
 *   npm run build:icons
 *   CHROME_BIN=/path/to/chrome npm run build:icons
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const svgSource = readFileSync(path.join(root, 'assets/logo.svg'), 'utf8');
const outDir = path.join(root, 'public/icon');
const sizes = [16, 32, 48, 96, 128, 256, 512, 1024];

const chromeCandidates = [
  process.env.CHROME_BIN,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function resolveChrome() {
  for (const candidate of chromeCandidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    'No Chrome/Chromium binary found. Install one or set CHROME_BIN to its executable path.',
  );
}

function assertPng(file, expectedSize) {
  const buffer = readFileSync(file);
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`${file} is not a PNG file`);
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${file} is ${width}x${height}, expected ${expectedSize}x${expectedSize}`);
  }
}

const chrome = resolveChrome();
const workDir = mkdtempSync(path.join(tmpdir(), 'lumo-icons-'));
const profileDir = path.join(workDir, 'profile');
const renderDir = path.join(workDir, 'out');
mkdirSync(profileDir, { recursive: true });
mkdirSync(renderDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

try {
  for (const size of sizes) {
    const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style>
</head>
<body>${svgSource}</body>
</html>`;

    const htmlPath = path.join(workDir, `${size}.html`);
    const pngPath = path.join(renderDir, `${size}.png`);
    writeFileSync(htmlPath, html);

    execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profileDir}`,
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${pngPath}`,
        pathToFileURL(htmlPath).href,
      ],
      { stdio: 'ignore' },
    );

    assertPng(pngPath, size);
  }

  for (const size of sizes) {
    copyFileSync(path.join(renderDir, `${size}.png`), path.join(outDir, `${size}.png`));
    console.log(`public/icon/${size}.png`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\nGenerated ${sizes.length} icons from assets/logo.svg`);
