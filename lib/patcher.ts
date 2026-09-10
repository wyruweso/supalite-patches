// Splice TypeScript implementations into bundle functions found by surviving AST names and literals.
// Resolve minified bindings and replace only the selected source ranges.
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
   /** Set by the loader from fixes/ or features/. */
   kind: 'fix' | 'feature'
   id: string
   title: string
   /** Full TAP paths that must fail before patching and pass afterwards. No other divergence is allowed. */
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

// Function anchors

/** Locate a method by its name and a sibling method; the pair must be unique. */
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

/** Locate a function by distinctive text in a string or template literal. */
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

/** Match a returned object; the schema collector contains the same keys without returning them. */
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

/** Append to a uniquely identified string literal. Reject templates with interpolated expressions. */
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

// Bundle bindings

/** Resolve a callee from helper(firstParameter.property), such as quote(node.idxname). */
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

/** Resolve an argument from a call identified by a literal, such as route("/auth/v1", authRoutes). */
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
 * Resolve a function's declared name from distinctive body text across the whole bundle.
 * Used for error factories that the target function does not call directly.
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

/** Resolve the unique callee name used with this argument count. Repeated calls are allowed. */
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

// Patch application

/** Replaces the body of a function in the bundle with the body of one from a readable file. */
export function replaceFunction(source: string, spec: Spec): string {
   const target = spec.at(parse(source, { sourceType: 'module' }))
   const names = resolveBindings(spec, target)

   const body = renderBody(spec.replacement, spec.exported, target.node.params, names)
   const { start, end } = target.node.body
   return source.slice(0, start) + body + source.slice(end)
}

/**
 * Rename the original method and insert a wrapper under its old name.
 * originalAs maps the wrapper's this-reference to the alias; repeated wrappers can stack.
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

   // Preserve whether callers receive a value or a promise.
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

/** Transpile, bind, validate, and render the replacement body. */
function renderBody(
   file: URL,
   exported: string,
   targetParams: FunctionDeclaration['params'],
   bindingNames: Record<string, string>,
   properties: Record<string, string> = {},
): string {
   const { ast, path } = transpile(file)
   const program = pathOfProgram(ast)
   const replacement = findReplacementFunction(ast, exported, path)

   // Move top-level helpers into the replacement body. Their constants are allocated on every call.
   const helpers = (program.get('body') as NodePath<Node>[])
      .map((statement) =>
         statement.isExportNamedDeclaration() && statement.node.declaration
            ? (statement.get('declaration') as NodePath<Node>)
            : statement,
      )
      .filter(
         (statement) =>
            statement.node !== replacement.node &&
            (statement.isFunctionDeclaration() || statement.isVariableDeclaration()),
      )
   const parameterNames = resolveParameterNames(replacement.node.params, targetParams, exported)

   // Bundle bindings apply to helpers too; positional parameters belong to the replacement only.
   const renamed: NodePath<Identifier>[] = []
   for (const helper of helpers) renamed.push(...applyRenames(helper, bindingNames, properties))
   renamed.push(...applyRenames(replacement, { ...bindingNames, ...parameterNames }, properties))
   assertNoCapture(renamed)

   const allowedNames = new Set<string>([
      ...Object.values(bindingNames),
      ...Object.values(parameterNames),
      ...helpers.flatMap((helper) => Object.keys(helper.getOuterBindingIdentifiers())),
   ])
   for (const scope of [replacement, ...helpers]) assertNoStrayReferences(scope, allowedNames)

   const code = [
      ...helpers.map((helper) => generate(helper.node, { comments: true }).code),
      ...replacement.node.body.body.map((statement) => generate(statement, { comments: true }).code),
   ]
   return ['{', ...code, '}'].join('\n')
}

function findReplacementFunction(ast: File, exported: string, filePath: string): NodePath<FunctionDeclaration> {
   let replacement: NodePath<FunctionDeclaration> | null = null
   traverse(ast, {
      FunctionDeclaration(path) {
         if (path.node.id?.name === exported && atTopLevel(path)) replacement = path
      },
   })
   if (!replacement) throw new Error(`${filePath} has no function ${exported}`)
   return replacement
}

// Minification changes parameter names but preserves their positions.
function resolveParameterNames(
   replacementParams: FunctionDeclaration['params'],
   targetParams: FunctionDeclaration['params'],
   exported: string,
): Record<string, string> {
   if (replacementParams.length !== targetParams.length) {
      throw new Error(`${exported}: has ${replacementParams.length} parameters, the bundle has ${targetParams.length}`)
   }

   const names: Record<string, string> = {}
   replacementParams.forEach((param, index) => {
      const from = nameOfParam(param)
      const to = nameOfParam(targetParams[index])
      if (!from || !to) throw new Error(`${exported}: parameter ${index} is not named`)
      names[from] = to
   })
   return names
}

/** TypeScript removes declare bindings and types while retaining comments. */
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
      Program(path) {
         program = path
         path.stop()
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
 * Rename identifiers directly: transpiled declare bindings have no scope for scope.rename.
 * Property names use a separate map.
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

      // Own properties only: inherited names such as toString must not become replacements.
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
 * Check renamed references against their original scopes to prevent capture by a local binding.
 * A same-named variable in a disjoint scope is allowed.
 */
function assertNoCapture(renamed: NodePath<Identifier>[]): void {
   const captured = new Set<string>()
   for (const path of renamed) {
      if (path.scope.getBinding(path.node.name)) captured.add(path.node.name)
   }
   if (captured.size) {
      throw new Error(
         `renaming would capture the patch's own names: ${[...captured].join(', ')} — rename them in the patch source`,
      )
   }
}

/** Reject references supplied by neither the bundle, the inserted code, nor allowed globals. */
function assertNoStrayReferences(func: NodePath<Node>, allowed: Set<string>): void {
   const stray = new Set<string>()
   func.traverse({
      Identifier(path) {
         if (!path.isReferencedIdentifier()) return
         const name = path.node.name
         if (allowed.has(name) || GLOBALS.has(name)) return

         // Module-scope bindings do not move with this function.
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

/** Explicit allowlist: an unknown free name usually indicates a missing bundle binding. */
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
   'TextDecoder',
   'TextEncoder',
   'Uint32Array',
   'Uint8Array',
   'undefined',
   'URL',
   'URLSearchParams',
])
