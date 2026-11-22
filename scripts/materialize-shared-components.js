const fs = require('fs');
const path = require('path');

const extensionRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(extensionRoot, '../../shared/vscode-components');
const sourcePackageJson = path.join(sourceRoot, 'package.json');
const sourceDist = path.join(sourceRoot, 'dist');
const targetRoot = path.join(extensionRoot, 'vendor', 'vscode-components');

// The extension only uses the failure browser's table/view helpers.
const USED_DIST_MODULES = ['common-webviews'];

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} not found: ${targetPath}`);
  }
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

  // Rebuild the local vendor snapshot from the shared package. Only the modules
  // the extension still imports are copied, and the manifest is regenerated so it
  // cannot point at components that are not vendored here.
  fs.rmSync(targetRoot, { recursive: true, force: true });

  fs.mkdirSync(targetRoot, { recursive: true });
  fs.writeFileSync(path.join(targetRoot, 'package.json'), vendoredPackageJson(), 'utf8');

  const targetDist = path.join(targetRoot, 'dist');
  for (const moduleName of USED_DIST_MODULES) {
    const sourceModule = path.join(sourceDist, moduleName);
    ensureExists(sourceModule, `shared component ${moduleName}`);
    copyDir(sourceModule, path.join(targetDist, moduleName));
  }

  console.log(`Materialized shared vscode-components into ${targetRoot}`);
}

function vendoredPackageJson() {
  return JSON.stringify(
    {
      name: '@monorepo-life/vscode-components',
      private: true,
      version: '0.0.1',
      main: './dist/common-webviews/index.js',
      types: './dist/common-webviews/index.d.ts',
      exports: {
        './common-webviews': {
          types: './dist/common-webviews/index.d.ts',
          default: './dist/common-webviews/index.js',
        },
      },
    },
    null,
    2,
  ) + '\n';
}

main();
