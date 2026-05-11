import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { get } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const host = '127.0.0.1';
const outputDir = resolve(rootDir, 'screenshots', 'smoke');
const minScreenshotBytes = 8 * 1024;

const shots = [
  { name: 'team-builder-mobile', path: '/team-builder', width: 390, height: 844 },
  { name: 'vector-library-mobile', path: '/vector-library', width: 390, height: 844 },
  { name: 'mcp-narrow', path: '/mcp', width: 768, height: 900 },
  { name: 'daemon-narrow', path: '/daemon', width: 768, height: 900 },
];

function findBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate));
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();

  return new Promise((resolveReady, reject) => {
    const tick = () => {
      const req = get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolveReady();
          return;
        }
        retry();
      });

      req.on('error', retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      setTimeout(tick, 250);
    };

    tick();
  });
}

function startDevServer(port) {
  const child = spawn(
    process.execPath,
    [join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', host, '--port', String(port), '--strictPort'],
    {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  child.stdout.resume();
  child.stderr.resume();

  return child;
}

function stopDevServer(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

function captureShot(browserPath, baseUrl, shot) {
  const target = new URL(shot.path, baseUrl).toString();
  const output = join(outputDir, `${shot.name}.png`);
  const profile = join(outputDir, `.profile-${shot.name}-${Date.now()}`);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    `--user-data-dir=${profile}`,
    `--window-size=${shot.width},${shot.height}`,
    '--virtual-time-budget=5000',
    `--screenshot=${output}`,
    target,
  ];

  const result = spawnSync(browserPath, args, {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(`Chrome failed for ${shot.name}: ${result.stderr || result.stdout}`);
  }

  const size = statSync(output).size;
  if (size < minScreenshotBytes) {
    throw new Error(`${shot.name} screenshot is suspiciously small (${size} bytes)`);
  }

  return { output, size };
}

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error('Chrome or Edge was not found. Set CHROME_BIN to the browser executable path.');
  }

  mkdirSync(outputDir, { recursive: true });

  let server;
  let baseUrl = process.env.SCREENSHOT_BASE_URL;
  if (!baseUrl) {
    const port = await getFreePort();
    baseUrl = `http://${host}:${port}/`;
    server = startDevServer(port);
  }

  try {
    await waitForServer(baseUrl);
    for (const shot of shots) {
      const result = captureShot(browserPath, baseUrl, shot);
      console.log(`${shot.name}: ${result.size} bytes -> ${result.output}`);
    }
  } finally {
    stopDevServer(server);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
