process.noAsar = true;

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const buildDir = path.join(rootDir, 'build');

function collectProdDependencies(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const nodeModulesDir = path.join(projectRoot, 'node_modules');
  const visited = new Set();
  const queue = Object.keys(pkg.dependencies || {});

  while (queue.length > 0) {
    const depName = queue.shift();
    if (!depName || visited.has(depName)) continue;
    const depDir = path.join(nodeModulesDir, ...depName.split('/'));
    const depPkgPath = path.join(depDir, 'package.json');
    if (!fs.existsSync(depPkgPath)) {
      throw new Error(`缺少生产依赖 "${depName}" (${depDir})，请先执行 npm install。`);
    }
    visited.add(depName);
    const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8'));
    for (const subDep of Object.keys(depPkg.dependencies || {})) {
      if (!visited.has(subDep)) queue.push(subDep);
    }
  }

  return [...visited];
}

function copyFileExact(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirFiltered(srcDir, destDir, allowFile) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(srcPath, destPath, allowFile);
    } else if (entry.isFile() && (!allowFile || allowFile(entry.name, srcPath))) {
      copyFileExact(srcPath, destPath);
    }
  }
}

function createZipArchive(stagingDir, zipPath) {
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
  const parentDir = path.dirname(stagingDir);
  const folderName = path.basename(stagingDir);

  if (process.platform === 'win32') {
    const psCmd = `Compress-Archive -LiteralPath '${stagingDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`;
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      stdio: 'inherit'
    });
  } else {
    for (const sh of ['install_macos.sh', 'restore_macos.sh', path.join('scripts', 'run_with_runtime.sh')]) {
      const shPath = path.join(stagingDir, sh);
      if (fs.existsSync(shPath)) {
        fs.chmodSync(shPath, 0o755);
      }
    }
    execFileSync('zip', ['-rq', zipPath, folderName], {
      cwd: parentDir,
      stdio: 'inherit'
    });
  }
}

function buildPortableRelease(options = {}) {
  const projectRoot = options.projectRoot || rootDir;
  const outBuildDir = options.buildDir || buildDir;
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const version = String(pkg.version || '0.0.0').trim();
  const folderName = `antigravity-zh-cn-v${version}-portable`;
  const portableRoot = path.join(outBuildDir, 'portable');
  const stagingDir = path.join(portableRoot, folderName);
  const zipName = `${folderName}.zip`;
  const zipPath = path.join(outBuildDir, zipName);
  const shaPath = `${zipPath}.sha256`;

  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stagingDir, { recursive: true });

  const rootFiles = [
    'package.json',
    'LICENSE',
    'README.md',
    'README.en.md',
    '一键修复或更新汉化.bat',
    '一键还原官方英文.bat',
    '一键免TUN启动.bat',
    'build_and_deploy.ps1',
    'install_macos.sh',
    'restore_macos.sh'
  ];
  for (const rel of rootFiles) {
    const src = path.join(projectRoot, rel);
    if (!fs.existsSync(src)) {
      throw new Error(`便携包缺少必需文件: ${src}`);
    }
    copyFileExact(src, path.join(stagingDir, rel));
  }

  const assetFiles = [
    'dictionary.json',
    'attr_dict.json',
    'preserve_list.json',
    'ota_rules.json',
    path.join('baseline', 'version.json')
  ];
  for (const rel of assetFiles) {
    const src = path.join(projectRoot, 'assets', rel);
    if (!fs.existsSync(src)) {
      throw new Error(`便携包缺少词库资源: ${src}`);
    }
    copyFileExact(src, path.join(stagingDir, 'assets', rel));
  }

  copyDirFiltered(
    path.join(projectRoot, 'scripts'),
    path.join(stagingDir, 'scripts'),
    (name) => name.endsWith('.js') || name.endsWith('.ps1') || name.endsWith('.sh')
  );

  const prodDeps = collectProdDependencies(projectRoot);
  for (const depName of prodDeps) {
    const srcDep = path.join(projectRoot, 'node_modules', ...depName.split('/'));
    const destDep = path.join(stagingDir, 'node_modules', ...depName.split('/'));
    copyDirFiltered(srcDep, destDep);
  }

  createZipArchive(stagingDir, zipPath);

  const zipBytes = fs.readFileSync(zipPath);
  const sha256 = crypto.createHash('sha256').update(zipBytes).digest('hex');
  fs.writeFileSync(shaPath, `${sha256}  ${zipName}\n`, 'utf8');

  return {
    version,
    stagingDir,
    zipPath,
    shaPath,
    sha256,
    sizeBytes: zipBytes.length,
    prodDeps
  };
}

if (require.main === module) {
  const res = buildPortableRelease();
  const sizeMb = (res.sizeBytes / (1024 * 1024)).toFixed(2);
  console.log(`Successfully built zero-Node portable release v${res.version}:`);
  console.log(` - Archive : ${res.zipPath} (${sizeMb} MB)`);
  console.log(` - SHA-256 : ${res.sha256}`);
  console.log(` - ProdDeps: ${res.prodDeps.join(', ')}`);
}

module.exports = {
  collectProdDependencies,
  buildPortableRelease
};
