// Marketplace assets (plan §10.2–10.3): icon PNG, screenshots and the demo GIF frames, from the real game.
// Usage: node scripts/render-assets.mjs [icon|shots|gif] (default: all). Needs Chrome/Edge and puppeteer-core
// (PUPPETEER_CORE env var pointing to an installed copy, or `npm i -D puppeteer-core`), plus Python + Pillow for the GIF.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_CORE || 'puppeteer-core');
const browserPath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].filter(Boolean).find((p) => fs.existsSync(p));
const what = process.argv[2] ?? 'all';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

execFileSync(process.execPath, ['esbuild.mjs', '--harness'], { stdio: 'ignore' });
const harness = pathToFileURL(path.resolve('webview/dev/index.html')).href;
fs.mkdirSync('media/screenshots', { recursive: true });

const browser = await puppeteer.launch({ executablePath: browserPath, headless: true, args: ['--hide-scrollbars'] });
try {
  if (what === 'all' || what === 'icon') {
    const page = await browser.newPage();
    await page.setViewport({ width: 256, height: 256, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(path.resolve('media/icon.svg')).href);
    await page.screenshot({ path: 'media/icon.png', omitBackground: true, clip: { x: 0, y: 0, width: 256, height: 256 } });
    console.log('media/icon.png');
    await page.close();
  }

  const open = async (query, w, h) => {
    const page = await browser.newPage();
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await page.goto(`${harness}?bare&w=${w}&h=${h}&${query}`);
    await sleep(900);
    return page;
  };
  const send = (page, m) => page.evaluate((msg) => window.postMessage(msg, '*'), m);
  const status = (state, sinceAgo = 37_000) => ({ type: 'status', v: 1, status: { state, sessions: 1, since: Date.now() - sinceAgo } });

  if (what === 'all' || what === 'shots') {
    const shots = [
      ['table-working', 'scenario=midhand&claude=working', 640, 760],
      ['needs-you', 'scenario=split&claude=waiting', 640, 760],
      ['blackjack', 'scenario=blackjack&claude=working&felt=blue', 640, 760],
      ['narrow-panel', 'scenario=insurance&claude=working', 380, 720],
    ];
    for (const [name, q, w, h] of shots) {
      const page = await open(q, w, h);
      await page.screenshot({ path: `media/screenshots/${name}.png` });
      console.log(`media/screenshots/${name}.png`);
      await page.close();
    }
    // 256-color palette PNGs: sharp at 2x, a fraction of the size.
    const shrink = `
import sys
from PIL import Image
for f in sys.argv[1:]:
    Image.open(f).convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(f, optimize=True)
`;
    execFileSync('python', ['-c', shrink, ...shots.map(([name]) => `media/screenshots/${name}.png`)], { stdio: 'inherit' });
  }

  if (what === 'all' || what === 'gif') {
    // A short story: Claude works → you play a hand → Claude needs you → back to work → done, finish your hand.
    // Chrome's screencast delivers a frame on every repaint, with a timestamp: smooth animations, and
    // each frame's duration in the GIF is the time until the next one.
    const dir = path.resolve('.dev/gif-frames');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 480, height: 600, deviceScaleFactor: 1 });
    await page.goto(`${harness}?bare&w=480&h=600&scenario=demo&claude=working`);
    await sleep(900);
    const cdp = await page.createCDPSession();
    const frames = [];
    cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      const file = path.join(dir, `${String(frames.length).padStart(4, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ file, t: metadata.timestamp });
      await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    const film = (ms) => sleep(ms);
    const key = (k) => page.keyboard.press(k);
    await send(page, status('working', 4000));
    await film(900);
    await key('Space'); // deal
    await film(2600);
    await key('KeyH'); // hit
    await film(1400);
    await send(page, status('waiting', 9000));
    await film(2000);
    await send(page, status('working', 14000));
    await film(900);
    await key('KeyS'); // stand
    await film(2600);
    await key('Space'); // next hand
    await film(2200);
    await send(page, { type: 'status', v: 1, status: { state: 'idle', sessions: 0 } });
    await send(page, { type: 'claudeDone', v: 1, mode: 'afterHand' });
    await film(1600);
    await key('KeyS');
    await film(3000);
    await cdp.send('Page.stopScreencast');
    // Durations: time to the next frame (the last one holds for 2 s).
    const timeline = frames.map((f, i) => ({ file: f.file, ms: Math.round(((frames[i + 1]?.t ?? f.t + 2) - f.t) * 1000) }));
    fs.writeFileSync(path.join(dir, 'timeline.json'), JSON.stringify(timeline));
    console.log(`${frames.length} frames in .dev/gif-frames`);
    // Assemble with Pillow (adaptive palette, only changed regions stored).
    // Resample at a fixed 12.5 fps (80 ms): the real timing is kept and the frame count stays bounded;
    // consecutive identical samples become one longer frame.
    const py = `
import json, sys
from PIL import Image, ImageChops
tl = json.load(open(sys.argv[1]))
starts, t = [], 0
for f in tl:
    starts.append(t); t += f['ms']
STEP, frames, durs, last_file = 80, [], [], None
i = 0
for s in range(0, t, STEP):
    while i + 1 < len(tl) and starts[i + 1] <= s:
        i += 1
    f = tl[i]['file']
    if f == last_file and durs:
        durs[-1] += STEP; continue
    img = Image.open(f).convert('RGB')
    if frames and not ImageChops.difference(img, frames[-1][1]).getbbox():
        durs[-1] += STEP; last_file = f; continue
    frames.append((img.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE), img)); durs.append(STEP); last_file = f
durs[-1] += 1500
q = [p for p, _ in frames]
q[0].save(sys.argv[2], save_all=True, append_images=q[1:], duration=durs, loop=0, optimize=True, disposal=1)
print(len(q), 'frames,', round(sum(durs) / 1000, 1), 's ->', sys.argv[2])
`;
    execFileSync('python', ['-c', py, path.join(dir, 'timeline.json'), path.resolve('media/demo.gif')], { stdio: 'inherit' });
  }
} finally {
  await browser.close();
}
