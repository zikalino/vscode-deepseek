const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(extensionRoot, '../../shared/vscode-components');
const sourcePackageJson = path.join(sourceRoot, 'package.json');
const sourceDist = path.join(sourceRoot, 'dist');
const targetRoot = path.join(extensionRoot, 'vendor', 'vscode-components');

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  fs.cpSync(srcDir, dstDir, { recursive: true, dereference: true });
}

function main() {
  if (!fs.existsSync(sourcePackageJson) || !fs.existsSync(sourceDist)) {
    ensureExists(path.join(targetRoot, 'package.json'), 'vendored shared package.json');
    ensureExists(path.join(targetRoot, 'dist'), 'vendored shared dist directory');
    console.log(`Using vendored vscode-components snapshot at ${targetRoot}`);
    return;
  }

  // Rebuild local vendor snapshot from shared package dist.
  fs.rmSync(targetRoot, { recursive: true, force: true });

  fs.mkdirSync(targetRoot, { recursive: true });
  copyFile(sourcePackageJson, path.join(targetRoot, 'package.json'));
  copyDir(sourceDist, path.join(targetRoot, 'dist'));

  console.log(`Materialized shared vscode-components into ${targetRoot}`);
}

main();
