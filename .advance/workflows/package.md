---
title: Package & Install VSIX
---

# Package & Install VSIX

Compiles the extension, packages the VSIX with vsce, installs it, then reports what happened.

<!-- input id=version label="Version (must match package.json)" placeholder="0.0.48" value="0.0.48" -->

<!-- script id=run label="Run" -->
npm run compile
vsce package --allow-missing-repository
code --install-extension vscode-deepseek-obsidian-{{version}}.vsix --force
agent A VSIX build and install just ran for version {{version}}. Check that the file vscode-deepseek-obsidian-{{version}}.vsix exists in /workspace and report concisely whether the build looks complete, the file's size, and anything that would block someone using the extension. Do not change any files.
<!-- end -->
