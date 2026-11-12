#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = process.cwd();
const srcRoot = path.join(root, 'src');
const config = JSON.parse(readFileSync(path.join(root, 'quality', 'architecture-layers.json'), 'utf8'));
const exceptionPath = path.join(root, 'quality', 'architecture-exceptions.json');
const exceptions = existsSync(exceptionPath) ? JSON.parse(readFileSync(exceptionPath, 'utf8')).exceptions ?? [] : [];

function filesUnder(directory) {
  return readdirSync(directory).flatMap((name) => {
    const value = path.join(directory, name);
    return statSync(value).isDirectory() ? filesUnder(value) : value.endsWith('.ts') ? [value] : [];
  });
}
function relative(file) { return path.relative(srcRoot, file).replaceAll('\\', '/'); }
function resolveImport(from, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    try { if (statSync(candidate).isFile() && candidate.startsWith(srcRoot)) return candidate; } catch { /* absent */ }
  }
  return null;
}
function importEdges(file) {
  const source = readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edges = [];
  const add = (target, kind) => {
    if (target && !edges.some((edge) => edge.target === target && edge.kind === kind)) edges.push({ target, kind });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
      const typeOnly = Boolean(clause?.isTypeOnly || (clause && !clause.name && named.length > 0 && named.every((item) => item.isTypeOnly)));
      add(resolveImport(file, node.moduleSpecifier.text), typeOnly ? 'type' : 'runtime');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(resolveImport(file, node.moduleSpecifier.text), node.isTypeOnly ? 'type' : 'runtime');
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) add(resolveImport(file, specifier.text), 'runtime');
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return edges;
}
function layerMatches(file) {
  const name = relative(file);
  return config.layers.filter((entry) => (entry.files ?? []).includes(name)).map((entry) => entry.name);
}
function stronglyConnected(graph) {
  let nextIndex = 0;
  const indices = new Map(); const low = new Map(); const stack = []; const onStack = new Set(); const result = [];
  const visit = (node) => {
    indices.set(node, nextIndex); low.set(node, nextIndex); nextIndex += 1; stack.push(node); onStack.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))); }
      else if (onStack.has(target)) low.set(node, Math.min(low.get(node), indices.get(target)));
    }
    if (low.get(node) === indices.get(node)) {
      const component = []; let item;
      do { item = stack.pop(); onStack.delete(item); component.push(item); } while (item !== node);
      if (component.length > 1 || (graph.get(node) ?? []).includes(node)) result.push(component);
    }
  };
  for (const node of graph.keys()) if (!indices.has(node)) visit(node);
  return result;
}

const files = filesUnder(srcRoot);
const fileNames = new Set(files.map(relative));
const errors = [];
const layerByFile = new Map();
for (const file of files) {
  const matches = layerMatches(file);
  if (matches.length !== 1) errors.push(`${relative(file)} matches ${matches.length} architecture layers (${matches.join(', ') || 'none'})`);
  else layerByFile.set(file, matches[0]);
}
for (const entry of config.layers) {
  for (const file of entry.files ?? []) if (!fileNames.has(file)) errors.push(`architecture layer ${entry.name} lists missing module ${file}`);
}

const today = new Date().toISOString().slice(0, 10);
const exceptionKeys = new Set();
for (const exception of exceptions) {
  const key = `${exception.from}\0${exception.to}\0${exception.kind}`;
  if (exceptionKeys.has(key)) errors.push(`duplicate architecture exception ${exception.from} -> ${exception.to} (${exception.kind})`);
  exceptionKeys.add(key);
  if (!fileNames.has(exception.from) || !fileNames.has(exception.to)) errors.push(`architecture exception references missing module ${exception.from} -> ${exception.to}`);
  if (!['runtime', 'type'].includes(exception.kind)) errors.push(`architecture exception kind must be exact runtime/type: ${exception.from} -> ${exception.to}`);
  if (!exception.reason || !exception.owner || !/^\d{4}-\d{2}-\d{2}$/u.test(exception.expires ?? '')) errors.push(`architecture exception lacks reason, owner, or ISO expiry: ${exception.from} -> ${exception.to}`);
  else if (exception.expires < today) errors.push(`expired architecture exception (${exception.expires}): ${exception.from} -> ${exception.to}`);
}

const allEdges = new Map(files.map((file) => [file, importEdges(file)]));
const usedExceptions = new Set();
for (const [from, edges] of allEdges) {
  for (const edge of edges) {
    const fromLayer = layerByFile.get(from); const toLayer = layerByFile.get(edge.target);
    if (!fromLayer || !toLayer || !config.forbidden.some((rule) => rule.from === fromLayer && rule.to === toLayer)) continue;
    const source = relative(from); const target = relative(edge.target);
    const key = `${source}\0${target}\0${edge.kind}`;
    if (exceptionKeys.has(key)) usedExceptions.add(key);
    else errors.push(`forbidden ${fromLayer} -> ${toLayer} ${edge.kind}: ${source} -> ${target}`);
  }
}
for (const exception of exceptions) {
  const key = `${exception.from}\0${exception.to}\0${exception.kind}`;
  if (!usedExceptions.has(key)) errors.push(`unused architecture exception (edge/layer drift): ${exception.from} -> ${exception.to} (${exception.kind})`);
}
const runtimeGraph = new Map([...allEdges].map(([file, edges]) => [file, edges.filter((edge) => edge.kind === 'runtime').map((edge) => edge.target)]));
for (const component of stronglyConnected(runtimeGraph)) {
  const names = component.map(relative).sort();
  const signature = names.join(' <-> ');
  if (!(config.allowedRuntimeCycles ?? []).includes(signature)) errors.push(`runtime cycle: ${signature}`);
}
if (errors.length > 0) {
  console.error('Architecture boundary check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
const counts = Object.fromEntries(config.layers.map((entry) => [entry.name, entry.files.length]));
console.log(`Architecture boundary check passed (${files.length} completely classified TypeScript modules; ${JSON.stringify(counts)}; ${exceptions.length} reviewed exceptions; no cycles).`);
