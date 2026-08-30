import { LanguageSupport, StreamLanguage } from '@codemirror/language'

const KEYWORDS = new Set([
  'module', 'function', 'if', 'else', 'for', 'intersection_for', 'let', 'each',
  'true', 'false', 'undef', 'include', 'use', 'assert', 'echo',
])

const BUILTINS = new Set([
  // solids and 2D
  'cube', 'sphere', 'cylinder', 'polyhedron', 'square', 'circle', 'polygon', 'text',
  // operations
  'linear_extrude', 'rotate_extrude', 'translate', 'rotate', 'scale', 'resize',
  'mirror', 'multmatrix', 'color', 'offset', 'hull', 'minkowski', 'union',
  'difference', 'intersection', 'render', 'surface', 'projection', 'import', 'children',
  // functions
  'str', 'len', 'concat', 'chr', 'ord', 'search', 'norm', 'cross', 'abs', 'sign',
  'sin', 'cos', 'tan', 'acos', 'asin', 'atan', 'atan2', 'floor', 'round', 'ceil',
  'ln', 'log', 'pow', 'sqrt', 'exp', 'rands', 'min', 'max', 'version',
  'is_undef', 'is_bool', 'is_num', 'is_string', 'is_list', 'is_function',
])

interface ModeState {
  inBlockComment: boolean
}

export const openscadMode = StreamLanguage.define<ModeState>({
  name: 'openscad',
  startState: () => ({ inBlockComment: false }),
  token(stream, state) {
    if (state.inBlockComment) {
      if (stream.skipTo('*/')) {
        stream.match('*/')
        state.inBlockComment = false
      } else {
        stream.skipToEnd()
      }
      return 'comment'
    }
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('/*')) {
      state.inBlockComment = true
      return 'comment'
    }
    // Special variables: $fn, $fa, $fs, $t, $vpr ...
    if (stream.match(/^\$[a-zA-Z_]\w*/)) return 'variableName.special'
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string'
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) return 'number'
    if (stream.match(/^[a-zA-Z_]\w*/)) {
      const word = stream.current()
      if (KEYWORDS.has(word)) return 'keyword'
      if (BUILTINS.has(word)) return 'typeName'
      return 'variableName'
    }
    if (stream.match(/^[-+*/%<>=!&|?:]+/)) return 'operator'
    stream.next()
    return null
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
  },
})

export const openscad = () => new LanguageSupport(openscadMode)
