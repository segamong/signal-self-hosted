'use strict';

// Copies upstream notices verbatim from the installed dependency graph. This
// script reads package metadata; it never imports dependency JavaScript.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const project = path.resolve(__dirname, '..');
const packages = new Map();
const unresolved = [];
const roots = ['react', 'react-dom', 'lucide-react', 'livekit-client', 'ws'];

function resolveRoot(name, from) {
  const resolver = createRequire(path.join(from, 'package.json'));
  try { return path.dirname(resolver.resolve(`${name}/package.json`)); } catch {}
  let entry;
  try { entry = resolver.resolve(name); } catch { return null; }
  if (!path.isAbsolute(entry)) return null;
  let current = path.dirname(entry);
  while (current !== path.dirname(current)) {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8'));
      if (json.name === name) return current;
    } catch {}
    current = path.dirname(current);
  }
  return null;
}

function visit(name, from) {
  const root = resolveRoot(name, from);
  if (!root) { unresolved.push(name); return; }
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const identity = `${metadata.name}@${metadata.version}`;
  if (packages.has(identity)) return;
  const notices = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[cs]es?([._-].*)?|copying([._-].*)?|notice([._-].*)?|copyright([._-].*)?)$/i.test(entry.name))
    .map((entry) => ({ name: entry.name, content: fs.readFileSync(path.join(root, entry.name), 'utf8') }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // This npm release omits standalone LICENSE files, but distributes the
  // original Apache notice and complete Google BSD terms in its source headers.
  if (!notices.length && metadata.name === '@bufbuild/protobuf') {
    for (const filename of ['dist/esm/index.js', 'dist/esm/google/varint.js']) {
      const source = fs.readFileSync(path.join(root, filename), 'utf8');
      const header = source.match(/^(?:\/\/[^\n]*(?:\n|$))+/)?.[0];
      if (!header) throw new Error(`Missing upstream header: ${metadata.name}/${filename}`);
      notices.push({ name: `${filename} (original license header)`, content: header });
    }
  }
  packages.set(identity, { metadata, notices });
  for (const dependency of Object.keys(metadata.dependencies || {})) visit(dependency, root);
}

for (const root of roots) visit(root, project);
if (unresolved.length) throw new Error(`Cannot resolve dependency licenses: ${[...new Set(unresolved)].join(', ')}`);
const missing = [...packages].filter(([, value]) => !value.notices.length).map(([identity]) => identity);
if (missing.length) throw new Error(`No upstream license file found: ${missing.join(', ')}`);

let output = 'SIGNAL DESKTOP — THIRD-PARTY NOTICES\n\n';
output += 'The following package versions are installed dependencies of the renderer\n';
output += 'and desktop WebSocket client. License and notice texts below are copied\n';
output += 'verbatim from their distributed package files. Build-only dependencies\n';
output += 'and the server are not included in this list.\n\n';
output += 'Electron, Chromium and their bundled components have their own LICENSE\n';
output += 'and LICENSES.chromium.html files distributed alongside the application.\n\n';
for (const [identity, { metadata, notices }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  output += `${'='.repeat(76)}\n${identity}\n`;
  output += `Declared license: ${typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license || metadata.licenses || 'See upstream notice')}\n`;
  const repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url;
  if (repository) output += `Repository: ${repository}\n`;
  if (metadata.homepage) output += `Homepage: ${metadata.homepage}\n`;
  for (const notice of notices) output += `\n--- ${notice.name} ---\n${notice.content}${notice.content.endsWith('\n') ? '' : '\n'}`;
  output += '\n';
}
fs.writeFileSync(path.join(__dirname, 'THIRD-PARTY-LICENSES.txt'), output, 'utf8');
process.stdout.write(`Copied upstream notices for ${packages.size} packages.\n`);
