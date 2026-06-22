// Screenshot a URL to ./temporary screenshots/screenshot-N[-label].png (auto-incremented).
// Usage: node screenshot.mjs http://localhost:3000 [label] [width]
import puppeteer from 'puppeteer';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] || '';
const width = parseInt(process.argv[4] || '1440', 10);

const OUT = join(process.cwd(), 'temporary screenshots');
mkdirSync(OUT, { recursive: true });

// auto-increment N
let max = 0;
for (const f of readdirSync(OUT)) {
  const m = f.match(/^screenshot-(\d+)/);
  if (m) max = Math.max(max, parseInt(m[1], 10));
}
const n = max + 1;
const name = `screenshot-${n}${label ? '-' + label : ''}.png`;
const dest = join(OUT, name);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
// scroll through the page so IntersectionObserver reveals fire (content un-hides)
await page.evaluate(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const step = Math.round(window.innerHeight * 0.8);
  for (let y = 0; y <= document.body.scrollHeight; y += step) {
    window.scrollTo(0, y); await sleep(120);
  }
  window.scrollTo(0, 0); await sleep(300);
  // force-reveal anything still hidden so the capture is deterministic
  document.querySelectorAll('.reveal').forEach((el) => { el.style.transitionDelay = '0ms'; el.classList.add('in'); });
});
// let fonts/animations settle
await new Promise(r => setTimeout(r, 700));
await page.screenshot({ path: dest, fullPage: true });
await browser.close();
console.log('Saved', dest);
