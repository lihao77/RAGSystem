import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const host = '127.0.0.1';
const outputDir = resolve(rootDir, 'screenshots', 'smoke');
const minScreenshotBytes = 8 * 1024;
const maxHorizontalOverflowPx = 2;

const shots = [
  { name: 'chat-mobile', path: '/', width: 390, height: 844 },
  { name: 'admin-mobile', path: '/admin', width: 390, height: 844 },
  { name: 'agent-config-narrow', path: '/agent-config', width: 768, height: 900 },
  { name: 'team-builder-mobile', path: '/team-builder', width: 390, height: 844 },
  { name: 'model-providers-narrow', path: '/model-providers', width: 768, height: 900 },
  { name: 'vector-library-mobile', path: '/vector-library', width: 390, height: 844 },
  { name: 'mcp-narrow', path: '/mcp', width: 768, height: 900 },
  { name: 'monitor-narrow', path: '/monitor', width: 768, height: 900 },
  { name: 'daemon-narrow', path: '/daemon', width: 768, height: 900 },
  { name: 'system-config-mobile', path: '/system-config', width: 390, height: 844 },
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

function getJson(url, timeoutMs = 5000) {
  return new Promise((resolveJson, reject) => {
    const req = get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GET ${url} returned ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolveJson(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out requesting ${url}`));
    });
  });
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function waitForDevtools(port, timeoutMs = 10000) {
  const startedAt = Date.now();
  const listUrl = `http://${host}:${port}/json/list`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const targets = await getJson(listUrl, 1000);
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome is still starting.
    }
    await wait(200);
  }

  throw new Error(`Timed out waiting for Chrome DevTools on port ${port}`);
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

function stopProcessTree(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

function stopDevServer(child) {
  stopProcessTree(child);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(webSocketUrl);
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      this.ws.addEventListener('open', resolveOpen, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
      this.ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          return;
        }
        pending.resolve(message.result);
      });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(payload);
    });
  }

  close() {
    this.ws.close();
  }
}

async function waitForReady(client, timeoutMs = 10000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await client.send('Runtime.evaluate', {
      expression: 'document.readyState',
      returnByValue: true,
    });
    if (result.result?.value === 'complete') {
      await wait(750);
      return;
    }
    await wait(200);
  }

  throw new Error('Timed out waiting for document.readyState=complete');
}

async function measureLayout(client) {
  const expression = `(() => {
    const doc = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const documentScrollWidth = Math.max(
      doc.scrollWidth,
      body ? body.scrollWidth : 0,
      doc.getBoundingClientRect().width,
      body ? body.getBoundingClientRect().width : 0
    );
    const horizontalOverflow = Math.max(0, Math.ceil(documentScrollWidth - viewportWidth));
    const visibleElements = Array.from(document.querySelectorAll('body *'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const overRight = Math.ceil(rect.right - viewportWidth);
        const overLeft = Math.ceil(-rect.left);
        if (overRight <= 2 && overLeft <= 2) return null;
        return {
          tag: element.tagName.toLowerCase(),
          className: String(element.className || '').slice(0, 120),
          text: String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          overLeft,
          overRight
        };
      })
      .filter(Boolean)
      .slice(0, 5);
    return {
      viewportWidth,
      viewportHeight,
      documentScrollWidth: Math.ceil(documentScrollWidth),
      horizontalOverflow,
      visibleElements
    };
  })()`;

  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
  });

  return result.result.value;
}

async function captureShot(browserPath, baseUrl, shot) {
  const target = new URL(shot.path, baseUrl).toString();
  const output = join(outputDir, `${shot.name}.png`);
  const profile = join(tmpdir(), `rag-screenshot-smoke-${shot.name}-${Date.now()}`);
  const debugPort = await getFreePort();
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    `--window-size=${shot.width},${shot.height}`,
    target,
  ];

  const browser = spawn(browserPath, args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  browser.stdout.resume();
  browser.stderr.resume();

  let client;
  try {
    const webSocketUrl = await waitForDevtools(debugPort);
    client = new CdpClient(webSocketUrl);
    await client.open();
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: 1,
      mobile: shot.width <= 480,
    });
    await client.send('Page.navigate', { url: target });
    await waitForReady(client);

    const layout = await measureLayout(client);
    if (layout.horizontalOverflow > maxHorizontalOverflowPx) {
      const offenders = layout.visibleElements
        .map((element) => `${element.tag}.${element.className} right=${element.right} text="${element.text}"`)
        .join('; ');
      throw new Error(
        `${shot.name} has ${layout.horizontalOverflow}px horizontal overflow ` +
          `(scrollWidth ${layout.documentScrollWidth}, viewport ${layout.viewportWidth}). ${offenders}`,
      );
    }

    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    writeFileSync(output, screenshot.data, 'base64');
  } finally {
    client?.close();
    stopProcessTree(browser);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // Windows can keep Chrome profile files locked briefly after taskkill.
    }
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
      const result = await captureShot(browserPath, baseUrl, shot);
      console.log(`${shot.name}: ok, ${result.size} bytes -> ${result.output}`);
    }
  } finally {
    stopDevServer(server);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
