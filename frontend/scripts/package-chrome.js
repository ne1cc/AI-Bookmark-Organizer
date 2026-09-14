import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const distDir = join(rootDir, 'dist');
const chromeDir = existsSync(join(distDir, 'chrome')) ? join(distDir, 'chrome') : distDir;
const pkgPath = join(rootDir, 'package.json');
const manifestPath = join(chromeDir, 'manifest.json');

if (!existsSync(manifestPath)) {
    console.error(`Error: ${manifestPath} not found. Run npm run build:chrome first.`);
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!manifest.side_panel && (!manifest.background || !manifest.background.service_worker)) {
    console.error(`Error: ${manifestPath} is not a valid Chrome manifest.`);
    process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version || '1.0.0';

const extZipName = `bookmark-organizer-chrome-v${version}.zip`;
const extZipPath = join(distDir, extZipName);

if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
}

if (existsSync(extZipPath)) rmSync(extZipPath);

console.log(`Packaging Chrome extension to dist/${extZipName}...`);
execFileSync('zip', ['-r', extZipPath, '.', '-x', '*.DS_Store', '*.zip'], {
    cwd: chromeDir,
    stdio: 'inherit'
});
console.log(`Chrome extension package created: dist/${extZipName}`);
