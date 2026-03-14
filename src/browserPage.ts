import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type BrowserPageBootstrap = {
  lichessUser: string;
  chessComUser: string;
};

const BROWSER_BOOTSTRAP_PLACEHOLDER = '__APP_BOOTSTRAP_JSON__';
const moduleDir = dirname(fileURLToPath(import.meta.url));
const browserAssetDirectories = [resolve(moduleDir, 'browser'), resolve(moduleDir, '../src/browser')];

function resolveBrowserAssetPath(fileName: string): string {
  for (const directory of browserAssetDirectories) {
    const candidate = resolve(directory, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Browser asset not found: ${fileName}`);
}

function readBrowserAsset(fileName: string): string {
  return readFileSync(resolveBrowserAssetPath(fileName), 'utf8');
}

function escapeScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const browserPageTemplate = readBrowserAsset('index.html');
const browserPageCss = readBrowserAsset('browserPage.css');

if (!browserPageTemplate.includes(BROWSER_BOOTSTRAP_PLACEHOLDER)) {
  throw new Error(`Missing bootstrap placeholder in browser template: ${BROWSER_BOOTSTRAP_PLACEHOLDER}`);
}

export function readBrowserPageCss(): string {
  return browserPageCss;
}

export function renderBrowserPage(bootstrap: BrowserPageBootstrap): string {
  return browserPageTemplate.replace(BROWSER_BOOTSTRAP_PLACEHOLDER, escapeScriptJson(bootstrap));
}
