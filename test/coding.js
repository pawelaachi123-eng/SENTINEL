'use strict';

/**
 * Parser-backed code intelligence checks across JavaScript/TypeScript, Python,
 * C/C++, C#, Java, PowerShell and SQL, plus indexing, impact, bug rules and a
 * hash-bound multi-file rename.
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parse, parseJavaScript, parsePython, parseBraceLanguage, parseSql, detectLanguage, walk } = require('../core/coding/parsers');
const { CodeIndex, RefactorEngine, isInside } = require('../core/coding');

const results = [];
function test(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-coding-'));
const write = (name, text) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

write('src/a.js', [
  "import defaultThing, { helper as assist } from './b.js';",
  "const { extra } = require('./c');",
  "export function greet(name) { return assist(name); }",
  "export const double = (n) => n * 2;",
  "class Service extends Base {",
  "  constructor(store) { this.store = store; }",
  "  run(input) { return this.store.get(input); }",
  "}",
  "function unsafe(x) { eval(x); }",
].join('\n'));
write('src/b.js', "export function helper(n) { return 'hi ' + n; }\n");
write('src/c.js', "module.exports = { extra: 1 };\n");
write('src/app.py', [
  'import os',
  'from helpers.util import parse',
  'class Runner:',
  '    def run(self, command):',
  '        return os.system(command)',
  '    def safe(self, value):',
  '        try:',
  '            return parse(value)',
  '        except ValueError:',
  '            pass',
].join('\n'));
write('src/native.c', '#include <stdio.h>\n#include <string.h>\nint copy(char *dst, char *src) {\n  strcpy(dst, src);\n  return 0;\n}\n');
write('src/native.cpp', '#include <vector>\nclass Buffer {\npublic:\n  int size() { return 1; }\n};\n');
write('src/Program.cs', 'using System;\nnamespace Demo {\n  public class Widget {\n    public int Size() { return 1; }\n  }\n}\n');
write('src/Main.java', 'package demo;\nimport java.util.List;\npublic class Main {\n  public static void main(String[] args) { System.out.println("x"); }\n}\n');
write('src/tool.ps1', 'function Invoke-Thing {\n  Invoke-Expression $args[0]\n}\nusing module ./Helper.psm1\n');
write('src/schema.sql', 'SELECT id, name FROM users WHERE id = 1;\nUPDATE users SET name = \'x\' WHERE id = 1;\n');
write('src/view.js', "document.body.innerHTML = userInput;\nif (a == b) { console.log('loose'); }\nconst apiKey = 'abcdefghijklmnop';\n");
write('src/loop.py', 'value = 1\n');
write('src/bad.js', 'function broken( {\n');
fs.symlinkSync(path.join(root, 'src/a.js'), path.join(root, 'src/link.js'));
fs.writeFileSync(path.join(root, 'src/huge.js'), 'x'.repeat(2 * 1024 * 1024 + 10));
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
write('node_modules/ignored.js', 'function ignored() {}\n');

test('JavaScript parser returns declarations, imports, arrows and methods', () => {
  const ast = parseJavaScript(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), { file: 'a.js' });
  const types = ast.body.map((entry) => entry.type);
  assert.ok(types.includes('ImportDeclaration'));
  assert.ok(types.includes('FunctionDeclaration'));
  assert.ok(types.includes('VariableDeclaration'));
  assert.ok(types.includes('ClassDeclaration'));
  const klass = ast.body.find((entry) => entry.type === 'ClassDeclaration');
  assert.equal(klass.name, 'Service');
  assert.equal(klass.parent, 'Base');
  assert.equal(klass.methods.length, 2);
  const arrow = ast.body.find((entry) => entry.type === 'VariableDeclaration' && entry.name === 'double');
  assert.equal(arrow.init.type, 'ArrowFunctionExpression');
  assert.equal(ast.body.find((entry) => entry.type === 'ImportDeclaration').source, './b.js');
  return `${ast.body.length} top-level nodes`;
});

test('Python parser builds nested class and method blocks', () => {
  const ast = parsePython(fs.readFileSync(path.join(root, 'src/app.py'), 'utf8'), { file: 'app.py' });
  assert.ok(ast.body.some((entry) => entry.type === 'ImportDeclaration'));
  const klass = ast.body.find((entry) => entry.type === 'ClassDeclaration');
  assert.equal(klass.name, 'Runner');
  const methods = [];
  walk(ast, (node) => { if (node.type === 'FunctionDeclaration') methods.push(node.name); });
  assert.deepEqual(methods, ['run', 'safe']);
  return `${methods.length} methods`;
});

test('C, C++, C#, Java and PowerShell parsers expose their real structure', () => {
  const c = parseBraceLanguage(fs.readFileSync(path.join(root, 'src/native.c'), 'utf8'), 'c', { file: 'native.c' });
  assert.ok(c.body.some((entry) => entry.type === 'ImportDeclaration' && entry.source === 'stdio.h'));
  assert.ok(c.body.some((entry) => entry.type === 'FunctionDeclaration' && entry.name === 'copy'));
  const cpp = parseBraceLanguage(fs.readFileSync(path.join(root, 'src/native.cpp'), 'utf8'), 'cpp', { file: 'native.cpp' });
  assert.ok(cpp.body.some((entry) => entry.type === 'ClassDeclaration' && entry.name === 'Buffer'));
  const cs = parseBraceLanguage(fs.readFileSync(path.join(root, 'src/Program.cs'), 'utf8'), 'csharp', { file: 'Program.cs' });
  assert.ok(cs.body.some((entry) => entry.type === 'ImportDeclaration' && entry.source === 'System'));
  assert.ok(cs.body.some((entry) => entry.type === 'ClassDeclaration' && entry.name === 'Widget'));
  const java = parseBraceLanguage(fs.readFileSync(path.join(root, 'src/Main.java'), 'utf8'), 'java', { file: 'Main.java' });
  assert.ok(java.body.some((entry) => entry.type === 'PackageDeclaration' && entry.name === 'demo'));
  assert.ok(java.body.some((entry) => entry.type === 'ClassDeclaration' && entry.name === 'Main'));
  const ps = parseBraceLanguage(fs.readFileSync(path.join(root, 'src/tool.ps1'), 'utf8'), 'powershell', { file: 'tool.ps1' });
  assert.ok(ps.body.some((entry) => entry.type === 'FunctionDeclaration' && entry.name === 'Invoke-Thing'));
  return 'five brace-language parsers';
});

test('SQL parser separates statements and extracts tables and columns', () => {
  const ast = parseSql(fs.readFileSync(path.join(root, 'src/schema.sql'), 'utf8'), { file: 'schema.sql' });
  assert.equal(ast.body.length, 2);
  assert.deepEqual(ast.body[0].tables, ['users']);
  assert.ok(ast.body[0].columns.includes('id'));
  assert.equal(ast.body[1].kind, 'UPDATE');
  return `${ast.body.length} statements`;
});

test('malformed source fails with a line and column', () => {
  assert.throws(() => parseJavaScript('function broken( {\n'), (err) => err.code === 'PARSE_ERROR' && Number.isInteger(err.line) && err.column >= 1);
  assert.throws(() => parseJavaScript('const x = "unterminated;\n'), /unterminated/);
  assert.throws(() => parsePython('  x = 1\n'), /indentation/);
  return 'loud failures';
});

test('language detection maps every supported extension', () => {
  const pairs = { 'a.js': 'javascript', 'a.ts': 'typescript', 'a.py': 'python', 'a.c': 'c', 'a.cpp': 'cpp', 'a.cs': 'csharp', 'a.java': 'java', 'a.ps1': 'powershell', 'a.sql': 'sql' };
  for (const [file, language] of Object.entries(pairs)) assert.equal(detectLanguage(file), language);
  assert.equal(detectLanguage('a.rb'), null);
  return Object.keys(pairs).length + ' extensions';
});

const index = new CodeIndex({ root });
test('the index scans source only, skipping symlinks, huge files and vendored trees', () => {
  const scan = index.scan();
  assert.ok(scan.files >= 8);
  assert.ok(scan.errors.length >= 1, 'the malformed fixture should be reported');
  assert.ok(![...index.files.keys()].some((file) => file.includes('node_modules')));
  assert.ok(![...index.files.keys()].some((file) => file.endsWith('link.js')));
  assert.ok(index.skipped.some((entry) => entry.reason.includes('symlink')));
  assert.ok(index.skipped.some((entry) => entry.reason.includes('larger')));
  return `${scan.files} files, ${scan.errors} parse errors`;
});

test('symbol search and references work across files', () => {
  assert.ok(index.search('helper').length >= 1);
  const definitions = index.definition('helper');
  assert.ok(definitions.length >= 1);
  const references = index.references('assist');
  assert.ok(references.some((entry) => entry.file === 'src/a.js'));
  const calls = index.callGraph();
  assert.ok(calls.nodes.includes('assist'));
  return `${definitions.length} definitions`;
});

test('impact analysis walks import edges up to the requested depth', () => {
  const impact = index.impact({ file: path.join(root, 'src/b.js'), depth: 2 });
  assert.ok(impact.files.includes('src/a.js'));
  assert.equal(impact.depth, 2);
  const symbolImpact = index.impact({ symbol: 'helper', depth: 2 });
  assert.ok(symbolImpact.files.includes('src/a.js'));
  return `${impact.files.length} files`;
});

test('static rules find real evidence and redact secrets', () => {
  const findings = index.bugs({ limit: 2000 });
  const rules = new Set(findings.map((finding) => finding.rule));
  for (const rule of ['unsafe-eval', 'unsafe-python', 'unsafe-c', 'unsafe-powershell', 'dom-xss', 'loose-equality', 'hardcoded-secret']) assert.ok(rules.has(rule), `missing ${rule}: ${[...rules].join(',')}`);
  const secret = findings.find((finding) => finding.rule === 'hardcoded-secret');
  assert.ok(!secret.evidence.includes('abcdefghijklmnop'));
  return `${findings.length} findings, ${rules.size} rules`;
});

test('test proposals name the real function and its parameters', () => {
  const proposals = index.proposeTests({ file: path.join(root, 'src/a.js'), limit: 10 });
  assert.ok(proposals.some((proposal) => proposal.symbol === 'greet' && proposal.suggestion.includes('greet(')));
  return `${proposals.length} proposals`;
});

test('a hash-bound multi-file rename is verified before it can be applied', () => {
  const engine = new RefactorEngine({ index });
  const change = engine.rename({ symbol: 'helper', to: 'assistValue' });
  assert.equal(change.ok, true);
  assert.ok(change.files >= 2);
  assert.ok(change.replacements >= 2);
  assert.equal(change.patches.some((patch) => patch.afterText.includes("'hi '") === false), true);
  const isolated = engine.verifyIsolated(change.patches);
  assert.equal(isolated.ok, true);
  assert.equal(engine.apply(change.patches, { approvedBy: 'tester' }).code, 'APPROVAL_REQUIRED');
  assert.equal(engine.apply(change.patches, { approvedBy: 'tester', approvalHash: 'not-the-hash' }).code, 'APPROVAL_MISMATCH');
  const applied = engine.apply(change.patches, { approvedBy: 'tester', approvalHash: change.approvalHash });
  assert.equal(applied.ok, true);
  const text = fs.readFileSync(path.join(root, 'src/b.js'), 'utf8');
  assert.match(text, /assistValue/);
  return `${change.files} files, ${change.replacements} replacements`;
});

test('a stale patch is rejected instead of overwriting a newer file', () => {
  const engine = new RefactorEngine({ index });
  const change = engine.rename({ symbol: 'extra', to: 'value' });
  assert.equal(change.ok, true);
  fs.appendFileSync(path.join(root, 'src/c.js'), '\n// edited after the proposal\n');
  const applied = engine.apply(change.patches, { approvedBy: 'tester', approvalHash: change.approvalHash });
  assert.equal(applied.code, 'STALE_PATCH');
  return 'hash mismatch refused';
});

test('paths outside the root are never indexed or patched', () => {
  assert.equal(isInside(root, path.join(root, 'src/a.js')), true);
  assert.equal(isInside(root, path.join(root, '..', 'elsewhere')), false);
  assert.throws(() => index.indexFile(path.join(root, '..', 'outside.js')), /outside/);
  return 'root boundary enforced';
});

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} coding checks passed.`);
if (failed.length) process.exitCode = 1;
