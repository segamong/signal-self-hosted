import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = 'node tools/prepare-android-release.mjs [--apk <signed-apk>] [--output <directory>]';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(usage);
  process.exit(0);
}
let apk = path.join(root, 'android/app/build/outputs/apk/release/app-release.apk');
let output = path.join(root, 'android/app/build/release');
for (let index = 0; index < args.length; index += 2) {
  const name = args[index];
  const value = args[index + 1];
  if (!['--apk', '--output'].includes(name) || !value || value.startsWith('--')) throw new Error(usage);
  if (name === '--apk') apk = path.resolve(value);
  else output = path.resolve(value);
}

// Gradle's metadata binds the published version to the exact APK output.
// Verify the APK signature with SDK apksigner before running this helper.
const metadata = JSON.parse(await readFile(path.join(path.dirname(apk), 'output-metadata.json'), 'utf8'));
const element = metadata.elements?.find(item => item.outputFile === path.basename(apk));
if (metadata.applicationId !== 'cloud.signal.android' || metadata.variantName !== 'release' || !element || element.filters?.length) {
  throw new Error('Expected the universal cloud.signal.android release APK and its Gradle output-metadata.json');
}
const version = element.versionName;
const versionCode = element.versionCode;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || !Number.isSafeInteger(versionCode) || versionCode < 1 || versionCode > 2_100_000_000) {
  throw new Error('Invalid Android release version');
}
const info = await stat(apk);
if (!info.isFile() || info.size < 1 || info.size > 200_000_000) throw new Error('APK must be between 1 and 200,000,000 bytes');
const sha256 = createHash('sha256').update(await readFile(apk)).digest('hex');
const file = `Signal-Android-${version}.apk`;
await mkdir(output, { recursive: true });
const target = path.join(output, file);
if (path.resolve(apk) !== path.resolve(target)) await copyFile(apk, target);
const manifest = { version, versionCode, file, sha256, size: info.size };
const temporary = path.join(output, `latest.json.${process.pid}.tmp`);
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(temporary, path.join(output, 'latest.json'));
console.log(`Prepared ${target}`);
console.log(`SHA-256: ${sha256}`);
