import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootDir = resolve(import.meta.dirname, '..');
const repoDir = resolve(rootDir, '..');
const distDir = join(rootDir, 'dist');
const ffDir = existsSync(join(distDir, 'firefox')) ? join(distDir, 'firefox') : distDir;
const pkgPath = join(rootDir, 'package.json');
const manifestPath = join(ffDir, 'manifest.json');

if (!existsSync(manifestPath)) {
    console.error(`Error: ${manifestPath} not found. Run npm run build:firefox first.`);
    process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!manifest.sidebar_action || !manifest.browser_specific_settings) {
    console.error(`Error: ${manifestPath} is not a valid Firefox manifest. Run npm run build:firefox first.`);
    process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const version = pkg.version || '1.0.0';

const extZipName = `bookmark-organizer-firefox-v${version}.zip`;
const sourceZipName = `bookmark-organizer-firefox-source-v${version}.zip`;
const extZipPath = join(distDir, extZipName);
const sourceZipPath = join(distDir, sourceZipName);

if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
}

// 1. Package extension build zip
if (existsSync(extZipPath)) rmSync(extZipPath);

console.log(`Packaging Firefox extension to dist/${extZipName}...`);
execFileSync('zip', ['-r', extZipPath, '.', '-x', '*.DS_Store', '*.zip'], {
    cwd: ffDir,
    stdio: 'inherit'
});
console.log(`Firefox extension package created: dist/${extZipName}`);

// 2. Package source zip for AMO
if (existsSync(sourceZipPath)) rmSync(sourceZipPath);

console.log(`Packaging source code to dist/${sourceZipName}...`);
execFileSync('zip', [
    '-r',
    sourceZipPath,
    'frontend',
    'README.md',
    'LICENSE',
    '-x',
    'frontend/node_modules/*',
    'frontend/dist/*',
    'frontend/.DS_Store',
    '*.DS_Store'
], {
    cwd: repoDir,
    stdio: 'inherit'
});
console.log(`Firefox source code package created: dist/${sourceZipName}`);
console.log('Firefox packaging complete!');
