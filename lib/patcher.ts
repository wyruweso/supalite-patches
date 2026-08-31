// Applies a readable TypeScript patch to a minified bundle.
//
// A patch is ordinary TypeScript, written at the path its target occupies in the source tree. This
// module splices the exported function from that file into the bundle; only the located function's
// body is replaced, so the other 500 KB come through byte for byte.
//
// Targets are found by what survives minification, never by textual anchors:
//
//   survived                      did not
//   ------------------------------------------------------
//   class method names            top-level function names
//   field and object key names    local variable names
//   string literals               parameter names
//
// Names we cannot know in advance are derived from the bundle: parameters positionally, module
// functions by a characteristic call.
import { parse } from '@babel/parser'
import _traverse, { type NodePath } from '@babel/traverse'
import _generate from '@babel/generator'
import type { File, FunctionDeclaration, Identifier, Node, ObjectProperty, Program } from '@babel/types'
import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const traverse = (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse
const generate = (_generate as unknown as { default?: typeof _generate }).default ?? _generate

/** Any function in the bundle: class method, declaration, expression, arrow. */
export type FnPath = NodePath<Node> & {
   node: { params: FunctionDeclaration['params']; body: Node & { start: number; end: number } }
}

export interface Patch {
   /** Directory name. Filled in by the loader. */
   dir: string
   /** Repairs a defect, or adds a capability its authors list as unimplemented. Filled in by the loader. */
   kind: 'fix' | 'feature'
   id: string
   title: string
   /**
    * Full TAP paths of the assertions that must fail on the published build and pass on the patched
    * one. The runner rejects both an undeclared divergence and a declared one that never happens.
    */
   expectedDivergence: string[]
   apply(source: string): string
}

/** How to locate the function to replace. */
export type Anchor = (ast: File) => FnPath

/** How to resolve a name the readable file cannot know: a module function the minifier renamed. */
export type Binding = (fn: FnPath) => string

export interface Spec {
   at: Anchor
   /** File holding the readable patch. */
   replacement: URL
   /** Name of the exported function in that file. */
   exported: string
   bind?: Record<string, Binding>
}

// --- anchors -------------------------------------------------------------------------------------

/**
 * A class method by name. Method names survive minification, but a name alone is not unique enough —
 * `inClassWith` names a sibling method, and a matching pair is no coincidence.
 */
export function methodNamed(name: string, inClassWith: string): Anchor {
   return (ast) =>
      unique(`method ${name} beside ${inClassWith}`, (found) => {
         traverse(ast, {
            ClassMethod(path) {
               if ((path.node.key as Identifier).name !== name) return
               const siblings = (path.parentPath.node as { body: { key?: Identifier }[] }).body.map((m) => m.key?.name)
               if (siblings.includes(inClassWith)) found(path as unknown as FnPath)
            },
         })
      })
}

/**
 * A function containing a distinctive string literal — the only reliable way to find a top-level
 * function, whose name the minifier erased while leaving message text alone.
 */
export function functionWithText(text: string): Anchor {
   return (ast) =>
      unique(`function containing ${JSON.stringify(text)}`, (found) => {
         const hit = (path: NodePath<Node>) => {
            const fn = path.getFunctionParent()
            if (fn) found(fn as unknown as FnPath)
         }
         traverse(ast, {
            StringLiteral(path) {
               if (path.node.value.includes(text)) hit(path)
            },
            TemplateElement(path) {
               if (path.node.value.cooked?.includes(text)) hit(path)
            },
         })
      })
}

/**
 * A function *returning* an object literal with these keys; keys survive minification. Returning
 * rather than merely containing, because the DDL schema collector assembles the same field set.
 */
export function functionReturningObject(keys: string[]): Anchor {
   return (ast) =>
      unique(`function returning { ${keys.join(', ')} }`, (found) => {
         traverse(ast, {
            ObjectExpression(path) {
               if (!path.parentPath.isReturnStatement()) return
               const present = new Set(
                  path.node.properties
                     .filter((p): p is ObjectProperty => p.type === 'ObjectProperty' && !p.computed)
                     .map((p) => (p.key as Identifier).name),
               )
               if (!keys.every((k) => present.has(k))) return
               const fn = path.getFunctionParent()
               if (fn) found(fn as unknown as FnPath)
            },
         })
      })
}

function unique(what: string, search: (found: (fn: FnPath) => void) => void): FnPath {
   const hits = new Set<FnPath>()
   search((fn) => hits.add(fn))
   if (hits.size !== 1) throw new Error(`${what}: found ${hits.size}, expected 1 — has the build changed?`)
   return [...hits][0]
}

/**
 * Appends text to a top-level string constant, found by something it contains — the third patchable
 * thing beside a function body and a wrapper. Some of the library is data: the auth schema is one
 * long DDL string, and a table missing from it is one the migrator will drop.
 *
 * The literal is replaced whole and re-quoted from its own parsed value; an interpolated template is
 * refused rather than mangled.
 */
export function appendToConstant(source: string, spec: { containing: string; addition: string }): string {
   const ast = parse(source, { sourceType: 'module' })

   const found = new Set<{ start: number; end: number; value: string }>()
   traverse(ast, {
      StringLiteral(path) {
         if (path.node.value.includes(spec.containing)) {
            found.add({ start: path.node.start!, end: path.node.end!, value: path.node.value })
         }
      },
      TemplateLiteral(path) {
         const cooked = path.node.quasis.map((quasi) => quasi.value.cooked ?? '').join('')
         if (!cooked.includes(spec.containing)) return
         if (path.node.expressions.length) {
            throw new Error(`the constant containing ${JSON.stringify(spec.containing)} is interpolated`)
         }
         found.add({ start: path.node.start!, end: path.node.end!, value: cooked })
      },
   })

   if (found.size !== 1) {
      throw new Error(
         `constant containing ${JSON.stringify(spec.containing)}: found ${found.size}, expected 1 — has the build changed?`,
      )
   }

   const [target] = [...found]
   return source.slice(0, target.start) + JSON.stringify(target.value + spec.addition) + source.slice(target.end)
}

// --- bindings ------------------------------------------------------------------------------------

/**
 * A module function found by the one use we are sure of: a call on `<first parameter>.<property>`.
 * Locates the identifier-quoting helper — `Qo(e.idxname)` in this build, something else in the next.
 */
export function calleeOfArgument(property: string): Binding {
   return (fn) => {
      const [firstParam] = fn.node.params
      if (firstParam?.type !== 'Identifier') throw new Error('first parameter is not an identifier')
      const owner = firstParam.name

      const found = new Set<string>()
      fn.traverse({
         CallExpression(path) {
            const [arg] = path.node.arguments
            if (path.node.callee.type !== 'Identifier') return
            if (arg?.type !== 'MemberExpression' || arg.computed) return
            if ((arg.object as Identifier).name !== owner) return
            if ((arg.property as Identifier).name !== property) return
            found.add(path.node.callee.name)
         },
      })
      if (found.size !== 1) throw new Error(`call on .${property}: found ${found.size}, expected 1`)
      return [...found][0]
   }
}

/**
 * A name passed to a call that another of its arguments identifies by string literal. Recovers a
 * module variable whose own name is gone: in `.route('/auth/v1', authRoutes)` the literal survived.
 */
export function argumentOfCall(literal: string, index: number): Binding {
   return (fn) => {
      const found = new Set<string>()
      fn.traverse({
         CallExpression(path) {
            const args = path.node.arguments
            if (!args.some((a) => a.type === 'StringLiteral' && a.value === literal)) return
            const target = args[index]
            if (target?.type === 'Identifier') found.add(target.name)
         },
      })
      if (found.size !== 1)
         throw new Error(`argument ${index} of a call with ${literal}: found ${found.size}, expected 1`)
      return [...found][0]
   }
}

/**
 * A module function found by a string literal in its body, searched across the whole program.
 *
 * The other bindings read a name off a use the target function itself makes, which is safer and so
 * the default. That does not reach an error factory: declared once, called from everywhere, with no
 * call inside the patched function to read the name off. Its message text identifies it instead.
 *
 * Matches the declaration, not the call, so `ct=()=>new $(400,"invalid_credentials",...)` yields
 * `ct`. Anything but exactly one match is refused.
 */
export function moduleFunctionWithText(text: string): Binding {
   return (fn) => {
      const program = fn.findParent((path) => path.isProgram())
      if (!program) throw new Error('the located function is not inside a program')

      const found = new Set<string>()
      const hit = (path: NodePath<Node>) => {
         const owner = path.getFunctionParent()
         if (!owner) return
         // Either shape the minifier leaves: a function declaration keeps its own name, an arrow
         // assigned to a constant takes the name of the constant it is bound to.
         if (owner.isFunctionDeclaration() && owner.node.id) found.add(owner.node.id.name)
         else if (owner.parentPath?.isVariableDeclarator()) {
            const id = (owner.parentPath.node as { id: Node }).id
            if (id.type === 'Identifier') found.add(id.name)
         }
      }
      program.traverse({
         StringLiteral(path) {
            if (path.node.value.includes(text)) hit(path)
         },
         TemplateElement(path) {
            if (path.node.value.cooked?.includes(text)) hit(path)
         },
      })

      if (found.size !== 1) {
         throw new Error(`function containing ${JSON.stringify(text)}: found ${found.size}, expected 1`)
      }
      return [...found][0]
   }
}

/** A module function called exactly once inside the located one with the given number of arguments. */
export function soleCalleeWithArity(arity: number): Binding {
   return (fn) => {
      const found = new Set<string>()
      fn.traverse({
         CallExpression(path) {
            if (path.node.callee.type !== 'Identifier') return
            if (path.node.arguments.length !== arity) return
            found.add(path.node.callee.name)
         },
      })
      if (found.size !== 1) throw new Error(`calls with ${arity} arguments: found ${found.size}, expected 1`)
      return [...found][0]
   }
}

// --- application ---------------------------------------------------------------------------------

/** Replaces the body of a function in the bundle with the body of one from a readable file. */
export function replaceFunction(source: string, spec: Spec): string {
   const target = spec.at(parse(source, { sourceType: 'module' }))
   const names = resolveBindings(spec, target)

   const body = renderBody(spec.replacement, spec.exported, target.node.params, names)
   const { start, end } = target.node.body
   return source.slice(0, start) + body + source.slice(end)
}

/**
 * Wraps a class method instead of rewriting it, for a patch that adds a special case to a large
 * function. The original is renamed and a short wrapper takes its name; the patch declares the
 * original on its `this` interface under a convenient name, and that property is renamed to match.
 *
 * Wrappers stack: an already-wrapped method is wrapped again rather than fought over.
 */
export function wrapMethod(source: string, spec: Spec & { originalAs: string }): string {
   const target = spec.at(parse(source, { sourceType: 'module' }))
   const method = target.node as unknown as { key: Identifier; params: FunctionDeclaration['params']; async?: boolean }

   const original = method.key.name
   let alias = `${original}$original`
   for (let n = 2; source.includes(alias); n++) alias = `${original}$original${n}`

   const names = resolveBindings(spec, target)
   const body = renderBody(spec.replacement, spec.exported, method.params, names, { [spec.originalAs]: alias })
   const params = method.params.map((p) => nameOfParam(p)).join(', ')

   const { start, end } = target.node as unknown as { start: number; end: number }
   const key = method.key as unknown as { start: number; end: number }
   const renamed = source.slice(start, key.start) + alias + source.slice(key.end, end)

   // Inherit the original's async-ness: wrapping a synchronous method in `async` would hand callers
   // a promise where they expect a value.
   const prefix = method.async ? 'async ' : ''
   return source.slice(0, start) + renamed + `${prefix}${original}(${params}) ${body}` + source.slice(end)
}

/** The same for a top-level function declaration, where the original is called by name. */
export function wrapFunction(source: string, spec: Spec): string {
   const target = spec.at(parse(source, { sourceType: 'module' }))
   const declaration = target.node as unknown as FunctionDeclaration
   if (declaration.type !== 'FunctionDeclaration' || !declaration.id) {
      throw new Error('only a function declaration can be wrapped — an expression has no name to call it by')
   }

   const original = declaration.id.name
   let alias = `${original}$original`
   for (let n = 2; source.includes(alias); n++) alias = `${original}$original${n}`

   const names: Record<string, string> = { original: alias, ...resolveBindings(spec, target) }
   const body = renderBody(spec.replacement, spec.exported, declaration.params, names)
   const params = declaration.params.map((p) => nameOfParam(p)).join(', ')

   const { start, end } = declaration as unknown as { start: number; end: number }
   const id = declaration.id as unknown as { start: number; end: number }
   const renamed = source.slice(start, id.start) + alias + source.slice(id.end, end)
   return source.slice(0, start) + renamed + `function ${original}(${params}) ${body}` + source.slice(end)
}

function resolveBindings(spec: Spec, target: FnPath): Record<string, string> {
   const names: Record<string, string> = {}
   for (const [readable, resolve] of Object.entries(spec.bind ?? {})) names[readable] = resolve(target)
   return names
}

/** Transpiles the readable patch, renames everything the bundle calls differently, returns its body. */
function renderBody(
   file: URL,
   exported: string,
   targetParams: FunctionDeclaration['params'],
   names: Record<string, string>,
   properties: Record<string, string> = {},
): string {
   const { ast, path } = transpile(file)
   const program = pathOfProgram(ast)

   let fn: NodePath<FunctionDeclaration> | null = null
   traverse(ast, {
      FunctionDeclaration(p) {
         if (p.node.id?.name === exported && atTopLevel(p)) fn = p
      },
   })
   if (!fn) throw new Error(`${path} has no function ${exported}`)
   const func: NodePath<FunctionDeclaration> = fn

   // The patch's other top-level declarations — its helpers and constants — move inside the body, so
   // the readable file can keep them beside the main function rather than nested inside it.
   const helpers = (program.get('body') as NodePath<Node>[])
      .map((statement) =>
         statement.isExportNamedDeclaration() && statement.node.declaration
            ? (statement.get('declaration') as NodePath<Node>)
            : statement,
      )
      .filter(
         (statement) =>
            statement.node !== func.node && (statement.isFunctionDeclaration() || statement.isVariableDeclaration()),
      )

   // Parameters map positionally: their names in the bundle are arbitrary, their order is not.
   if (func.node.params.length !== targetParams.length) {
      throw new Error(`${exported}: has ${func.node.params.length} parameters, the bundle has ${targetParams.length}`)
   }
   const params: Record<string, string> = {}
   func.node.params.forEach((param, i) => {
      const from = nameOfParam(param)
      const to = nameOfParam(targetParams[i])
      if (!from || !to) throw new Error(`${exported}: parameter ${i} is not named`)
      params[from] = to
   })

   // Bound names are renamed across the file, helpers included. Parameter names only inside the main
   // function — helpers have their own.
   const renamed: NodePath<Identifier>[] = []
   for (const helper of helpers) renamed.push(...applyRenames(helper, names, properties))
   renamed.push(...applyRenames(func, { ...names, ...params }, properties))
   assertNoCapture(renamed)

   const carried = new Set<string>([
      ...Object.values(names),
      ...Object.values(params),
      ...helpers.flatMap((h) => Object.keys(h.getOuterBindingIdentifiers())),
   ])
   for (const scope of [func, ...helpers]) assertNoStrayReferences(scope, carried)

   const code = [
      ...helpers.map((h) => generate(h.node, { comments: true }).code),
      ...func.node.body.body.map((statement) => generate(statement, { comments: true }).code),
   ]
   return ['{', ...code, '}'].join('\n')
}

/**
 * Transpiled by TypeScript rather than babel: it already drops the `declare` statements that name the
 * patch's external bindings. Comments are kept — they are half the value of the inserted code.
 */
function transpile(file: URL): { ast: File; path: string } {
   const path = fileURLToPath(file)
   const js = ts.transpileModule(readFileSync(path, 'utf8'), {
      fileName: path,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: false },
   }).outputText
   return { ast: parse(js, { sourceType: 'module' }), path }
}

/** Top level, allowing for an exported declaration being wrapped in `export`. */
function atTopLevel(path: NodePath<Node>): boolean {
   const parent = path.parentPath
   return !!parent && (parent.isProgram() || (parent.isExportNamedDeclaration() && !!parent.parentPath?.isProgram()))
}

function pathOfProgram(ast: File): NodePath<Program> {
   let program: NodePath<Program> | null = null
   traverse(ast, {
      Program(p) {
         program = p
         p.stop()
      },
   })
   if (!program) throw new Error('the patch file has no program')
   return program
}

/** A plain or defaulted parameter name. The wrapper forwards the argument; the original defaults it. */
function nameOfParam(param: FunctionDeclaration['params'][number] | undefined): string | null {
   if (param?.type === 'Identifier') return param.name
   if (param?.type === 'AssignmentPattern' && param.left.type === 'Identifier') return param.left.name
   return null
}

/**
 * Renaming is done by hand rather than with `scope.rename`, because names the patch `declare`s are
 * free and have no scope. One rule for both: rename an identifier used as a name, never as a key.
 */
function applyRenames(
   func: NodePath<Node>,
   rename: Record<string, string>,
   properties: Record<string, string> = {},
): NodePath<Identifier>[] {
   const renamed: NodePath<Identifier>[] = []
   const visit = (path: NodePath<Identifier>) => {
      const parent = path.parent as Node & { computed?: boolean; property?: Node; key?: Node }
      const isProperty =
         (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') &&
         parent.property === path.node &&
         !parent.computed
      const isKey =
         (parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') &&
         parent.key === path.node &&
         !parent.computed

      // Properties use a separate map: `this.introspectOriginal(...)` is a member access, not a name
      // in scope. `Object.hasOwn` rather than a plain lookup, or inherited names like `toString`
      // match and `new URLSearchParams(x).toString()` becomes nonsense.
      if (isProperty || isKey) {
         if (Object.hasOwn(properties, path.node.name)) path.node.name = properties[path.node.name]
         return
      }

      if (Object.hasOwn(rename, path.node.name)) {
         path.node.name = rename[path.node.name]
         renamed.push(path)
      }
   }

   func.traverse({ Identifier: visit })
   if (func.isFunctionDeclaration()) {
      func.get('params').forEach((p) => {
         if (p.isIdentifier()) visit(p)
      })
   }
   return renamed
}

/**
 * Renaming is by name, not by binding (see `applyRenames`), so the new name must be free where it
 * lands. Otherwise it captures: parameter `introspection` becomes `t`, the patch declares a `t` of
 * its own, and two variables collapse into one. `assertNoStrayReferences` misses this — the name
 * resolves, just to the wrong thing.
 *
 * Checked per renamed reference so the check sees scope: a helper's own `t` in a disjoint scope is
 * not a capture. Bindings were tabulated before renaming, so they reflect what the patch declared.
 */
function assertNoCapture(renamed: NodePath<Identifier>[]): void {
   const captured = new Set<string>()
   for (const path of renamed) if (path.scope.getBinding(path.node.name)) captured.add(path.node.name)
   if (captured.size) {
      throw new Error(
         `renaming would capture the patch's own names: ${[...captured].join(', ')} — rename them in the patch source`,
      )
   }
}

/**
 * Last check before splicing: no name in the body may come from nowhere. A free reference means the
 * patch reaches for something in its own module, which in the bundle is absent or means something
 * else — better caught at build time than as a ReferenceError inside someone else's library.
 */
function assertNoStrayReferences(func: NodePath<Node>, allowed: Set<string>): void {
   const stray = new Set<string>()
   func.traverse({
      Identifier(path) {
         if (!path.isReferencedIdentifier()) return
         const name = path.node.name
         if (allowed.has(name) || GLOBALS.has(name)) return

         // A binding counts only if it is inside the function being inserted. A name declared higher
         // up the file has nowhere to come from.
         const binding = path.scope.getBinding(name)
         if (binding && isWithin(binding.scope, func.scope)) return
         stray.add(name)
      },
   })
   if (stray.size) throw new Error(`free names left in the body: ${[...stray].join(', ')}`)
}

function isWithin(inner: { parent?: unknown }, outer: unknown): boolean {
   for (let scope: typeof inner | undefined = inner; scope; scope = scope.parent as typeof inner) {
      if (scope === outer) return true
   }
   return false
}

/**
 * Standard names the inserted code may reach for. Hand-maintained on purpose: an unlisted, unbound
 * name reaching the bundle is far more likely a mistake than a global.
 */
const GLOBALS = new Set([
   'Array',
   'atob',
   'btoa',
   'Boolean',
   'console',
   'crypto',
   'Date',
   'encodeURIComponent',
   'Error',
   'JSON',
   'Map',
   'Math',
   'Number',
   'Object',
   'parseInt',
   'Promise',
   'RegExp',
   'Response',
   'Set',
   'String',
   'Symbol',
   'TextEncoder',
   'Uint8Array',
   'undefined',
   'URL',
   'URLSearchParams',
])
