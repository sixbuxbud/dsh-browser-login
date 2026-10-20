#!/usr/bin/env node
/**
 * 把 dsh-browser-login 装进一个 DSH profile。
 *
 *   node scripts/install.mjs                 # 装进默认 profile（~/.dsh/profiles/desktop）
 *   node scripts/install.mjs --profile <dir> # 指定 profile 目录
 *   node scripts/install.mjs --uninstall     # 卸载
 *
 * 做三件事：
 *   1. profile 的 package.json 里写 link: 依赖；
 *   2. dsh.profile.bundles 里追加包名（bundle 的 cordis.patch.yml 会插入插件行）；
 *   3. 在 profile 的 node_modules 下建目录联接，保证 loader 能按名字解析到本包。
 * 全程幂等，改动前的 package.json 会备份为 package.json.bak。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')
const PACKAGE_NAME = 'dsh-browser-login'

function parseArgs(argv) {
  const options = { uninstall: false, profile: '' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--profile') options.profile = argv[++i] || ''
    else if (arg.startsWith('--profile=')) options.profile = arg.slice('--profile='.length)
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

function defaultProfile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'profiles', 'desktop')
}

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function linkInto(profileDir) {
  const modules = path.join(profileDir, 'node_modules')
  const target = path.join(modules, PACKAGE_NAME)
  await fs.mkdir(modules, { recursive: true })
  if (await exists(target)) {
    const stat = await fs.lstat(target)
    if (!stat.isSymbolicLink() && !stat.isDirectory()) await fs.rm(target, { force: true })
    else return 'already'
  }
  try {
    await fs.symlink(PACKAGE_DIR, target, process.platform === 'win32' ? 'junction' : 'dir')
    return 'linked'
  } catch (error) {
    // 没有符号链接权限时退化为复制（包很小）
    await fs.cp(PACKAGE_DIR, target, { recursive: true })
    return 'copied'
  }
}

async function unlinkFrom(profileDir) {
  const target = path.join(profileDir, 'node_modules', PACKAGE_NAME)
  if (!(await exists(target))) return 'absent'
  await fs.rm(target, { recursive: true, force: true })
  return 'removed'
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('用法：node scripts/install.mjs [--profile <profile 目录>] [--uninstall]')
    return
  }
  const profileDir = path.resolve(options.profile || defaultProfile())
  const manifestPath = path.join(profileDir, 'package.json')
  if (!(await exists(manifestPath))) {
    console.error('找不到 profile：' + manifestPath)
    console.error('用 --profile 指定 DSH profile 目录，例如 --profile C:\\Users\\你\\.dsh\\profiles\\desktop')
    process.exitCode = 1
    return
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.dependencies = manifest.dependencies || {}
  manifest.dsh = manifest.dsh || {}
  manifest.dsh.profile = manifest.dsh.profile || {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []

  if (options.uninstall) {
    delete manifest.dependencies[PACKAGE_NAME]
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME)
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    const link = await unlinkFrom(profileDir)
    console.log('已卸载 ' + PACKAGE_NAME + '（node_modules：' + link + '）。重启 DSH 后生效。')
    return
  }

  const linkSpec = 'link:' + PACKAGE_DIR
  const changed = []
  if (manifest.dependencies[PACKAGE_NAME] !== linkSpec) {
    manifest.dependencies[PACKAGE_NAME] = linkSpec
    changed.push('依赖')
  }
  if (!bundles.includes(PACKAGE_NAME)) {
    bundles.push(PACKAGE_NAME)
    changed.push('bundle 列表')
    manifest.dsh.profile.bundles = bundles
  }
  if (changed.length) {
    await fs.writeFile(manifestPath + '.bak', JSON.stringify(manifest, null, 2), 'utf8').catch(() => {})
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }
  const link = await linkInto(profileDir)

  console.log('profile：' + profileDir)
  console.log('插件包：' + PACKAGE_DIR)
  console.log('改动：' + (changed.length ? changed.join(' + ') : '无（已安装过）'))
  console.log('node_modules 联接：' + link)
  console.log('')
  console.log('下一步：重启 DeepSeek Harness，然后在对话里说「用 browser_login 登录 bilibili」即可。')
}

main().catch((error) => {
  console.error('安装失败：' + (error && error.message ? error.message : error))
  process.exitCode = 1
})
