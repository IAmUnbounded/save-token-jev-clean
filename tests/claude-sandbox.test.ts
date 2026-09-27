import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Claude Code function hooks run in a restricted sandbox: no `process`, no Node builtins, and only
 * the modules reachable from the registered entrypoint. `src/client.ts` reaches
 * `node:child_process` and `node:os` for its Keychain lookup, so one stray import from the hook
 * would break plugin loading at runtime with nothing in the type system to catch it.
 *
 * These tests pin that boundary. They read source, never `dist`, so `npm test` does not depend on
 * a prior build.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRYPOINT = 'src/integrations/claude.ts';

/** The only modules the hook may pull in at runtime. */
const EXPECTED_RUNTIME_CLOSURE = ['src/compact-core.ts', 'src/integrations/claude.ts', 'src/render.ts'];

/** `src/types.ts` is interface-only, imported with `import type`, and erased at emit. */
const EXPECTED_TYPE_ONLY_REACHABLE = ['src/types.ts'];

/** What `npm run build` must place in the plugin directory, relative to its `dist`. */
const EXPECTED_PLUGIN_DIST = [
  'compact-core.js',
  'integrations/claude.js',
  'render.js',
  'types.js',
];

interface Specifier {
  spec: string;
  typeOnly: boolean;
}

/**
 * Collects module specifiers from the TypeScript AST rather than by pattern matching, so
 * `import type` is distinguished from `import`, and dynamic `import()`/`require()` are seen.
 * A named import without the `type` keyword counts as runtime even if it only binds types:
 * erring in that direction keeps the boundary strict.
 */
function specifiersOf(file: string): Specifier[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const found: Specifier[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const typeOnly = node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      found.push({ spec: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push({ spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      found.push({ spec: node.moduleReference.expression.text, typeOnly: false });
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const argument = node.arguments[0];
      if ((isDynamicImport || isRequire) && argument && ts.isStringLiteralLike(argument)) {
        found.push({ spec: argument.text, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

/** Maps an emitted-style relative specifier (`../render.js`) back to its source file. */
function sourceFileFor(importer: string, spec: string): string {
  const candidate = resolve(dirname(importer), spec.replace(/\.js$/, '.ts'));
  if (!existsSync(candidate)) {
    throw new Error(`${relative(ROOT, importer)} imports "${spec}", which resolves to no source file`);
  }
  return candidate;
}

interface Graph {
  runtime: Set<string>;
  typeOnlyReachable: Set<string>;
  bareRuntimeSpecifiers: Record<string, string[]>;
}

/** Walks relative imports transitively from the entrypoint, following runtime edges only. */
function walkGraph(entry: string): Graph {
  const runtime = new Set<string>();
  const typeOnlyReachable = new Set<string>();
  const bareRuntimeSpecifiers: Record<string, string[]> = {};

  const visit = (file: string): void => {
    if (runtime.has(file)) return;
    runtime.add(file);
    for (const { spec, typeOnly } of specifiersOf(file)) {
      if (!spec.startsWith('.')) {
        if (typeOnly) continue;
        const key = relative(ROOT, file);
        bareRuntimeSpecifiers[key] = [...(bareRuntimeSpecifiers[key] ?? []), spec];
        continue;
      }
      const target = sourceFileFor(file, spec);
      if (typeOnly) typeOnlyReachable.add(target);
      else visit(target);
    }
  };

  visit(entry);
  return { runtime, typeOnlyReachable, bareRuntimeSpecifiers };
}

function filesUnder(directory: string, prefix = ''): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const full = join(directory, entry);
      return statSync(full).isDirectory() ? filesUnder(full, `${prefix}${entry}/`) : [`${prefix}${entry}`];
    })
    .sort();
}

const graph = walkGraph(resolve(ROOT, ENTRYPOINT));
const runtimeFiles = [...graph.runtime].map((file) => relative(ROOT, file)).sort();
const typeOnlyFiles = [...graph.typeOnlyReachable]
  .map((file) => relative(ROOT, file))
  .filter((file) => !runtimeFiles.includes(file))
  .sort();

describe('Claude function-hook sandbox boundary', () => {
  it('reaches exactly the sandbox-safe runtime closure', () => {
    expect(runtimeFiles).toEqual(EXPECTED_RUNTIME_CLOSURE);
  });

  it('reaches type-only modules without creating a runtime edge to them', () => {
    expect(typeOnlyFiles).toEqual(EXPECTED_TYPE_ONLY_REACHABLE);
  });

  it('never reaches src/client.ts, which needs node:child_process and node:os', () => {
    expect(runtimeFiles).not.toContain('src/client.ts');
    // Guard the premise: if client.ts stopped being Node-only, this test would have lost its point.
    expect(readFileSync(resolve(ROOT, 'src/client.ts'), 'utf8')).toContain('node:child_process');
  });

  it('has no bare runtime imports anywhere in the closure', () => {
    expect(graph.bareRuntimeSpecifiers).toEqual({});
  });

  it('has no node: builtin imports anywhere in the closure', () => {
    const offenders = runtimeFiles.flatMap((file) =>
      specifiersOf(resolve(ROOT, file))
        .filter(({ spec, typeOnly }) => !typeOnly && spec.startsWith('node:'))
        .map(({ spec }) => `${file} -> ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe('Claude plugin build output', () => {
  const pluginDist = resolve(ROOT, 'plugins/claude-save-token-jev/dist');
  const built = existsSync(pluginDist);

  // Skipped rather than failed when absent: `npm test` must not require a prior `npm run build`.
  // The source-graph tests above are the primary guard; this checks the shipped artifact.
  it.skipIf(!built)('emits only the sandbox-safe closure into the plugin directory', () => {
    expect(filesUnder(pluginDist)).toEqual(EXPECTED_PLUGIN_DIST);
  });

  it.skipIf(!built)('emits no node: imports into the plugin directory', () => {
    const offenders = filesUnder(pluginDist).filter((file) =>
      readFileSync(join(pluginDist, file), 'utf8').includes('node:'),
    );
    expect(offenders).toEqual([]);
  });

  it.skipIf(!built)('points hooks.json at a module inside the plugin directory', () => {
    const pluginRoot = resolve(ROOT, 'plugins/claude-save-token-jev');
    const hooksFile = join(pluginRoot, 'hooks/hooks.json');
    const { modules } = JSON.parse(readFileSync(hooksFile, 'utf8')) as { modules: string[] };
    expect(modules).toHaveLength(1);

    // Claude Code resolves a module spec against the plugin root and rejects any path that
    // leaves it, so the resolved target must stay inside and must exist.
    const target = resolve(pluginRoot, join(relative(pluginRoot, dirname(hooksFile)), modules[0]!));
    const within = relative(pluginRoot, target);
    expect(within.startsWith('..')).toBe(false);
    expect(existsSync(target)).toBe(true);
  });
});
