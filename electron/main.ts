/**
 * OpenMAIC Electron 主进程
 *
 * 同时启动两个子进程：
 *   1. Next.js 生产服务器（端口 3000）
 *   2. render-service（端口 9000，用于 MP4 视频导出）
 *
 * 等两个服务就绪后，创建 BrowserWindow 加载应用。
 */
import { app, BrowserWindow, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as net from 'node:net';

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 打包后 resources 目录；开发时为项目根目录 */
const RESOURCES_DIR = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..');

/** 项目根目录（包含 .next、render-service 等） */
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'openmaic')
  : path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// 环境变量配置
// ---------------------------------------------------------------------------

function resolveFfmpegPath(): string {
  // 1. 打包后从 resources/ffmpeg 查找
  const bundled = path.join(RESOURCES_DIR, 'ffmpeg', 'ffmpeg.exe');
  if (fs.existsSync(bundled)) return bundled;

  // 2. 从 ffmpeg-static 包查找
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ffmpeg = require('ffmpeg-static') as string;
    if (ffmpeg && fs.existsSync(ffmpeg)) return ffmpeg;
  } catch {
    // 忽略
  }

  return 'ffmpeg';
}

function resolveChromiumPath(): string {
  // 1. 打包后从 resources/chromium 查找
  const candidates = [
    path.join(RESOURCES_DIR, 'chromium', 'chrome-headless-shell.exe'),
    path.join(RESOURCES_DIR, 'chromium', 'chrome-headless-shell', 'chrome-headless-shell.exe'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // 2. 开发时从 puppeteer 缓存查找
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const puppeteer = require('puppeteer');
    const execPath = puppeteer.executablePath?.();
    if (execPath && fs.existsSync(execPath)) return execPath;
  } catch {
    // 忽略
  }

  return '';
}

function setupEnv(): void {
  // render-service 地址
  process.env.RENDER_SERVICE_URL = 'http://127.0.0.1:9000';

  // FFmpeg
  const ffmpegPath = resolveFfmpegPath();
  if (ffmpegPath !== 'ffmpeg') {
    process.env.FFMPEG_PATH = ffmpegPath;
    // 把 ffmpeg 所在目录加入 PATH，确保 hyperframes producer 能找到
    const ffmpegDir = path.dirname(ffmpegPath);
    process.env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH ?? ''}`;
  }

  // Chromium (headless shell)
  const chromiumPath = resolveChromiumPath();
  if (chromiumPath) {
    process.env.PUPPETEER_EXECUTABLE_PATH = chromiumPath;
    process.env.PRODUCER_HEADLESS_SHELL_PATH = chromiumPath;
  }

  // render-service 配置
  process.env.PORT = '9000';
  process.env.RENDER_RESOURCE_PROFILE = 'standard';
  process.env.HF_STATIC_DEDUP = 'false';
  process.env.PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS = '900000';
  process.env.RENDER_MAX_JOBS_PER_USER = '0';
  process.env.PRODUCER_TMP_PROJECT_DIR = path.join(
    app.getPath('userData'),
    'render-tmp',
  );

  // Next.js 配置（通过子进程 env 传递，不直接修改 process.env）
  if (!process.env.PORT) {
    (process.env as Record<string, string>).PORT = '3000';
  }
  (process.env as Record<string, string>).NODE_ENV = 'production';

  // 确保用户数据目录存在
  fs.mkdirSync(process.env.PRODUCER_TMP_PROJECT_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// 子进程管理
// ---------------------------------------------------------------------------

let nextProcess: ChildProcess | null = null;
let renderProcess: ChildProcess | null = null;

function spawnNext(): ChildProcess {
  // 使用 Next.js standalone 输出模式，只需 node server.js
  const serverPath = path.join(APP_ROOT, '.next', 'standalone', 'server.js');
  const args = [serverPath];

  console.log('[electron] Starting Next.js (standalone):', serverPath);
  const child = spawn(process.execPath, args, {
    cwd: path.join(APP_ROOT, '.next', 'standalone'),
    env: {
      ...process.env,
      // 关键：让 Electron 以 Node.js 模式运行 JS 文件，而不是启动 Electron 应用
      ELECTRON_RUN_AS_NODE: '1',
      PORT: '3000',
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
    },
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    console.error('[electron] Next.js failed to start:', err);
  });

  return child;
}

function spawnRenderService(): ChildProcess {
  const entry = path.join(APP_ROOT, 'render-service', 'dist', 'main.js');
  console.log('[electron] Starting render-service:', entry);

  const child = spawn(process.execPath, [entry], {
    cwd: path.join(APP_ROOT, 'render-service'),
    env: {
      ...process.env,
      // 关键：让 Electron 以 Node.js 模式运行 JS 文件
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: 'inherit',
  });

  child.on('error', (err) => {
    console.error('[electron] render-service failed to start:', err);
  });

  return child;
}

function killProcesses(): void {
  if (renderProcess) {
    try {
      renderProcess.kill();
    } catch {
      // 忽略
    }
    renderProcess = null;
  }
  if (nextProcess) {
    try {
      nextProcess.kill();
    } catch {
      // 忽略
    }
    nextProcess = null;
  }
}

// ---------------------------------------------------------------------------
// 端口等待
// ---------------------------------------------------------------------------

function waitForPort(port: number, timeoutMs = 120000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.setTimeout(2000);
      socket.on('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.on('timeout', () => {
        socket.destroy();
        retry();
      });
      socket.on('error', () => {
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timeout waiting for port ${port}`));
      } else {
        setTimeout(tryConnect, 1000);
      }
    };
    tryConnect();
  });
}

// ---------------------------------------------------------------------------
// 窗口管理
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'OpenMAIC',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // 加载 Next.js 应用
  mainWindow.loadURL('http://127.0.0.1:3000');

  // 外部链接在系统浏览器中打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  setupEnv();

  console.log('[electron] APP_ROOT =', APP_ROOT);
  console.log('[electron] RESOURCES_DIR =', RESOURCES_DIR);
  console.log('[electron] FFMPEG_PATH =', process.env.FFMPEG_PATH ?? '(PATH)');
  console.log(
    '[electron] CHROMIUM_PATH =',
    process.env.PUPPETEER_EXECUTABLE_PATH ?? '(not found)',
  );

  // 启动两个服务
  nextProcess = spawnNext();
  renderProcess = spawnRenderService();

  try {
    // 等待 Next.js 就绪
    console.log('[electron] Waiting for Next.js on port 3000...');
    await waitForPort(3000);
    console.log('[electron] Next.js is ready.');

    // render-service 可能启动稍慢，给它点时间
    console.log('[electron] Waiting for render-service on port 9000...');
    try {
      await waitForPort(9000, 60000);
      console.log('[electron] render-service is ready.');
    } catch {
      console.warn(
        '[electron] render-service did not become ready in time; MP4 export may be unavailable.',
      );
    }

    createWindow();
  } catch (error) {
    console.error('[electron] Failed to start services:', error);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  killProcesses();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  killProcesses();
});
