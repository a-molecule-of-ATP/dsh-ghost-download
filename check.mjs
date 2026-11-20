// Repository self-check. Runs in CI and locally; needs no DSH host.
//
// It checks the invariants that break silently: a setting that is documented but
// never shipped, a vendored import missing from the package, a locale that does
// not parse, a doc pointing at an image that is not in the repo.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
let problems = 0;
const fail = (message) => { problems += 1; console.error(`  x ${message}`); };
const pass = (message) => console.log(`  ok ${message}`);

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// 1. every @deepseek-ai import must exist on disk and be listed in `files`
const source = readFileSync(path.join(root, 'index.js'), 'utf8');
const vendored = [...new Set([...source.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/g)].map((m) => m[1]))];
for (const name of vendored) {
  const rel = `node_modules/${name}`;
  if (!existsSync(path.join(root, rel))) fail(`${name} is imported but not vendored`);
  // `files` can never carry node_modules: npm strips it. Only bundledDependencies
  // puts it in the tarball, and that requires a matching dependencies entry.
  if ((pkg.dependencies ?? {})[name] === undefined) fail(`${name} is imported but missing from dependencies`);
  if (!(pkg.bundledDependencies ?? []).includes(name)) {
    fail(`${name} is imported but not in bundledDependencies — npm would drop it from the tarball`);
  }
}
if (vendored.length > 0) pass(`${vendored.length} vendored import(s) shipped`);

// 2. every configured setting must be documented
const mod = await import(pathToFileURL(path.join(root, 'index.js')).href);
const fields = Object.keys(mod.Config?.dict ?? {});
const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
const undocumented = fields.filter((field) => !readme.includes(field));
if (undocumented.length > 0) fail(`settings missing from README: ${undocumented.join(', ')}`);
else pass(`${fields.length} settings documented`);

// 3. locales parse and carry a title + description
for (const lang of ['zh', 'en']) {
  const file = path.join(root, 'locale', `${lang}.json`);
  let dict;
  try {
    dict = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`locale/${lang}.json does not parse: ${error.message}`);
    continue;
  }
  if (!dict.meta?.title) fail(`locale/${lang}.json has no meta.title`);
  if (!dict.meta?.description) fail(`locale/${lang}.json has no meta.description`);
}
pass('locales parse');

// 4. documented images must exist in the repository
const docs = path.join(root, 'docs');
if (existsSync(docs)) {
  for (const name of readdirSync(docs).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(path.join(docs, name), 'utf8');
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
      if (!existsSync(path.join(docs, match[1]))) fail(`docs/${name} references missing ${match[1]}`);
    }
  }
  pass('doc images resolve');
}

// 5. every checksum algorithm must be documented in all three prose files.
//    Adding one to the implementation but not the docs is what left `crc32`
//    missing from two of them while the third said "5 of 5".
const checksumMatch = /const CHECKSUM_ALGORITHMS = \{([\s\S]*?)\};/.exec(source);
if (checksumMatch === null) {
  fail('cannot find CHECKSUM_ALGORITHMS in index.js');
} else {
  const algorithms = [...checksumMatch[1].matchAll(/([a-z0-9]+):\s*'/g)].map((m) => m[1]);
  const prose = ['README.md', 'docs/DETAIL.zh.md', 'docs/DETAIL.md']
    .map((name) => ({ name, text: readFileSync(path.join(root, name), 'utf8') }));
  const gaps = [];
  for (const algorithm of algorithms) {
    for (const file of prose) if (!file.text.includes(algorithm)) gaps.push(`${algorithm} in ${file.name}`);
  }
  if (gaps.length > 0) fail(`checksum algorithms missing from prose: ${gaps.join(', ')}`);
  else pass(`${algorithms.length} checksum algorithms documented`);
}

console.log(problems === 0 ? '\nSELF-CHECK OK' : `\n${problems} PROBLEM(S)`);
process.exitCode = problems === 0 ? 0 : 1;
