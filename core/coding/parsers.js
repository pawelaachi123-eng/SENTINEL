'use strict';

/**
 * Parser front-end for the coding-intelligence subsystem.
 *
 * These are real hand-written parsers, not regex heuristics over raw text. Each
 * one produces a small AST with source ranges, and the index builds symbols,
 * references, imports and calls from that AST. Coverage is deliberately stated:
 *
 *   • JavaScript/TypeScript: imports, exports, functions, arrows, classes,
 *     methods, variable declarations, calls and member access. It is a practical
 *     subset, not a complete ECMAScript parser.
 *   • Python: indentation-based classes, defs, imports, assignments and calls.
 *   • C, C++, C#, Java, PowerShell: brace/statement structure, includes/usings,
 *     classes and methods, calls, variables.
 *   • SQL: statements plus FROM/JOIN/INSERT/UPDATE table and column references.
 *
 * Malformed input fails with a PARSE_ERROR carrying a line and column rather
 * than silently producing an empty index.
 */

const fs = require('node:fs');
const path = require('node:path');

const KEYWORDS = new Set('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await static get set of as from true false null undefined interface type enum implements public private protected internal readonly declare namespace abstract override sealed using'.split(' '));
const JS_OPEN = new Set(['(', '[', '{']);
const JS_CLOSE = new Set([')', ']', '}']);
const OPERATORS = ['>>>=', '===', '!==', '**=', '>>>', '<<=', '>>=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**', '...', '?.'];
const LANGUAGE_BY_EXTENSION = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.pyw': 'python',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.cs': 'csharp', '.java': 'java', '.ps1': 'powershell', '.psm1': 'powershell', '.sql': 'sql',
};

function fail(message, line = 1, column = 1, code = 'PARSE_ERROR') {
  return Object.assign(new Error(`${message} at ${line}:${column}`), { code, line, column });
}

function detectLanguage(file) {
  return LANGUAGE_BY_EXTENSION[path.extname(String(file || '')).toLowerCase()] || null;
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

function position(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

/** Language-aware lexer. Comments are skipped; strings stay single tokens. */
function tokenize(text, language = 'javascript') {
  const starts = lineStarts(text);
  const tokens = [];
  let index = 0;
  const push = (type, value, start, end) => tokens.push({ type, value, start, end, ...position(starts, start) });
  const skipQuoted = (from, quote) => {
    let cursor = from + 1;
    while (cursor < text.length) {
      if (text[cursor] === '\\' || (language === 'powershell' && text[cursor] === '`')) { cursor += 2; continue; }
      if (text[cursor] === quote) return { end: cursor + 1, closed: true };
      if (text[cursor] === '\n' && quote !== '`') return { end: cursor, closed: false };
      cursor += 1;
    }
    return { end: cursor, closed: false };
  };
  const skipTemplate = (from) => {
    let cursor = from + 1;
    while (cursor < text.length) {
      if (text[cursor] === '\\') { cursor += 2; continue; }
      if (text[cursor] === '`') return { end: cursor + 1, closed: true };
      if (text[cursor] === '$' && text[cursor + 1] === '{') {
        cursor = skipBraces(cursor + 2);
        continue;
      }
      cursor += 1;
    }
    return { end: cursor, closed: false };
  };
  const skipBraces = (from) => {
    let cursor = from;
    let depth = 1;
    while (cursor < text.length) {
      const char = text[cursor];
      if (char === '\\') { cursor += 2; continue; }
      if (char === '"' || char === "'") { cursor = skipQuoted(cursor, char).end; continue; }
      if (char === '`') { cursor = skipTemplate(cursor).end; continue; }
      if (char === '/' && text[cursor + 1] && !['/', '*'].includes(text[cursor + 1])) {
        let previousCursor = cursor - 1;
        while (previousCursor >= 0 && /\s/.test(text[previousCursor])) previousCursor -= 1;
        const previousChar = previousCursor >= 0 ? text[previousCursor] : '';
        if (/[\w$)\]}]/.test(previousChar)) { cursor += 1; continue; }
        let regexCursor = cursor + 1;
        let inClass = false;
        while (regexCursor < text.length) {
          if (text[regexCursor] === '\\') { regexCursor += 2; continue; }
          if (text[regexCursor] === '[') inClass = true;
          else if (text[regexCursor] === ']') inClass = false;
          else if (text[regexCursor] === '/' && !inClass) { regexCursor += 1; break; }
          else if (text[regexCursor] === '\n') break;
          regexCursor += 1;
        }
        cursor = regexCursor;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') { depth -= 1; if (depth === 0) return cursor + 1; }
      cursor += 1;
    }
    return cursor;
  };
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (language !== 'sql' && language !== 'powershell' && char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index += 1; continue; }
    if (language !== 'sql' && language !== 'powershell' && char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw fail('unterminated block comment', ...Object.values(position(starts, index)).slice(0, 2));
      index = end + 2;
      continue;
    }
    if (char === '\\' && text[index + 1] === '\n') { index += 2; continue; }
    if (char === '<' && text[index + 1] === '#' && language === 'powershell') {
      const end = text.indexOf('#>', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === '#' && (language === 'python' || language === 'powershell')) { while (index < text.length && text[index] !== '\n') index += 1; continue; }
    if (char === '-' && text[index + 1] === '-' && language === 'sql') { while (index < text.length && text[index] !== '\n') index += 1; continue; }
    if (char === '/' && text[index + 1] === '*' && language === 'sql') { const end = text.indexOf('*/', index + 2); index = end < 0 ? text.length : end + 2; continue; }
    if ((language === 'javascript' || language === 'typescript') && char === '/' && text[index + 1] !== '/' && text[index + 1] !== '*') {
      const previous = tokens[tokens.length - 1];
      const division = previous && ((previous.type === 'identifier' && !KEYWORDS.has(previous.value)) || previous.type === 'number' || previous.type === 'string' || previous.type === 'regex' || [')', ']'].includes(previous.value));
      if (!division) {
        const start = index;
        index += 1;
        let inClass = false;
        let closed = false;
        while (index < text.length) {
          if (text[index] === '\\') { index += 2; continue; }
          if (text[index] === '[') inClass = true;
          else if (text[index] === ']') inClass = false;
          else if (text[index] === '/' && !inClass) { index += 1; closed = true; break; }
          else if (text[index] === '\n') break;
          index += 1;
        }
        if (!closed) {
          const at = position(starts, start);
          throw fail('unterminated regular expression', at.line, at.column);
        }
        while (index < text.length && /[a-z]/i.test(text[index])) index += 1;
        push('regex', text.slice(start, index), start, index);
        continue;
      }
    }
    if (char === '"' || char === "'" || char === '`') {
      const start = index;
      const scanned = char === '`' ? skipTemplate(index) : skipQuoted(index, char);
      index = scanned.end;
      if (!scanned.closed) {
        const at = position(starts, start);
        throw fail('unterminated string', at.line, at.column);
      }
      push('string', text.slice(start, index), start, index);
      continue;
    }
    if (/[0-9]/.test(char)) {
      const start = index;
      while (index < text.length && /[0-9a-fA-FxXoObBeE._+-]/.test(text[index])) {
        if ((text[index] === '+' || text[index] === '-') && !/[eE]/.test(text[index - 1])) break;
        index += 1;
      }
      push('number', text.slice(start, index), start, index);
      continue;
    }
    if ((language === 'c' || language === 'cpp') && char === 'R' && text[index + 1] === '"') {
      const start = index;
      const open = text.indexOf('(', index + 2);
      if (open < 0) throw fail('unterminated raw string', ...Object.values(position(starts, index)).slice(0, 2));
      const delimiter = text.slice(index + 2, open);
      const closing = `)${delimiter}"`;
      const end = text.indexOf(closing, open + 1);
      if (end < 0) { const at = position(starts, start); throw fail('unterminated raw string', at.line, at.column); }
      index = end + closing.length;
      push('string', text.slice(start, index), start, index);
      continue;
    }
    if (/[\p{L}_$]/u.test(char)) {
      const start = index;
      while (index < text.length && /[\p{L}\p{N}_$]/u.test(text[index])) index += 1;
      push('identifier', text.slice(start, index), start, index);
      continue;
    }
    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, index));
    if (operator) { push('operator', operator, index, index + operator.length); index += operator.length; continue; }
    if ('{}()[];,.?:+-*/%=<>!&|^~@#'.includes(char)) { push('operator', char, index, index + 1); index += 1; continue; }
    const at = position(starts, index);
    throw fail(`unexpected character ${JSON.stringify(char)} near ${JSON.stringify(text.slice(Math.max(0, index - 30), index + 10))}`, at.line, at.column);
  }
  return tokens;
}

function node(type, token, extra = {}) {
  return { type, line: token ? token.line : 1, column: token ? token.column : 1, start: token ? token.start : 0, end: token ? token.end : 0, ...extra };
}

function matching(tokens, index, language) {
  const open = tokens[index].value;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    if (tokens[cursor].value === open) depth += 1;
    else if (tokens[cursor].value === close) {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  const token = tokens[index];
  throw fail(`unbalanced ${open}`, token.line, token.column);
}

function validateBalance(tokens) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (const token of tokens) {
    if (JS_OPEN.has(token.value)) stack.push(token);
    else if (JS_CLOSE.has(token.value)) {
      const top = stack.pop();
      if (!top || top.value !== pairs[token.value]) throw fail(`unexpected ${token.value}`, token.line, token.column);
    }
  }
  if (stack.length) throw fail(`unclosed ${stack[stack.length - 1].value}`, stack[stack.length - 1].line, stack[stack.length - 1].column);
}

/**
 * JavaScript/TypeScript parser. Returns a Program AST with declarations,
 * imports/exports and expression nodes sufficient for indexing and refactoring.
 */
function parseJavaScript(source, { file = 'input.js' } = {}) {
  const tokens = tokenize(source, 'javascript');
  validateBalance(tokens);
  let index = 0;
  const peek = (offset = 0) => tokens[index + offset] || null;
  const value = (offset = 0) => (peek(offset) ? peek(offset).value : null);
  const expect = (wanted) => {
    const token = peek();
    if (!token || token.value !== wanted) throw fail(`expected ${wanted}, found ${token ? token.value : 'end of file'}`, token ? token.line : 1, token ? token.column : 1);
    index += 1;
    return token;
  };
  const identifier = () => {
    const token = peek();
    if (!token || token.type !== 'identifier') throw fail(`expected an identifier, found ${token ? token.value : 'end of file'}`, token ? token.line : 1, token ? token.column : 1);
    index += 1;
    return token;
  };
  const skipStatement = () => {
    let depth = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.value === '{' || token.value === '(') depth += 1;
      if (token.value === '}' || token.value === ')') depth = Math.max(0, depth - 1);
      index += 1;
      if (token.value === ';' && depth === 0) return;
      if (token.value === '}' && depth === 0) return;
    }
  };
  const parseExpression = () => {
    const start = peek();
    if (!start) return node('Empty', null);
    const parts = [];
    let depth = 0;
    while (index < tokens.length) {
      const token = peek();
      if (depth === 0 && [';', '}', ')', ','].includes(token.value)) break;
      if (token.value === '{' || token.value === '(' || token.value === '[') depth += 1;
      if (token.value === '}' || token.value === ')' || token.value === ']') { if (depth === 0) break; depth -= 1; }
      parts.push(token);
      index += 1;
      if (depth === 0 && token.value === '=>') continue;
      if (depth === 0 && peek() && peek().type === 'identifier' && !['and', 'or'].includes(peek().value) && parts.length > 0 && !['.', '?.'].includes(parts[parts.length - 1].value) && token.value !== '=' && token.value !== '=>' && token.value !== '?') break;
    }
    if (!parts.length) { index += 1; return node('Empty', start); }
    return node('Expression', start, { end: parts[parts.length - 1].end, text: source.slice(start.start, parts[parts.length - 1].end), identifiers: parts.filter((token) => token.type === 'identifier' && !KEYWORDS.has(token.value)).map((token) => ({ name: token.value, line: token.line, column: token.column })) });
  };
  const parseParams = () => {
    const params = [];
    if (value() !== '(') return params;
    const close = matching(tokens, index);
    index += 1;
    while (index < close) {
      const token = peek();
      if (token.type === 'identifier' && !KEYWORDS.has(token.value)) params.push({ name: token.value, line: token.line, column: token.column });
      index += 1;
    }
    index = close + 1;
    return params;
  };
  const parseBlock = () => {
    const open = expect('{');
    let depth = 1;
    while (index < tokens.length && depth > 0) {
      if (tokens[index].value === '{') depth += 1;
      else if (tokens[index].value === '}') depth -= 1;
      index += 1;
    }
    const end = tokens[index - 1];
    return node('Block', open, { end: end.end, endLine: end.line });
  };
  const parseFunction = (start, { async = false, exported = false } = {}) => {
    expect('function');
    if (value() === '*') index += 1;
    const nameToken = identifier();
    const params = parseParams();
    const body = value() === '{' ? parseBlock() : (skipStatement(), node('Block', null, { empty: true }));
    return node('FunctionDeclaration', start, { name: nameToken.value, id: nameToken, params, body, async, exported, end: body.end, endLine: body.endLine || start.line });
  };
  const parseClass = (start, { exported = false } = {}) => {
    expect('class');
    const nameToken = identifier();
    let parent = null;
    if (value() === 'extends') { index += 1; parent = identifier().value; }
    expect('{');
    const methods = [];
    while (index < tokens.length && value() !== '}') {
      if (value() === ';') { index += 1; continue; }
      const methodStart = peek();
      let isStatic = false;
      let isAsync = false;
      if (value() === 'static') { isStatic = true; index += 1; }
      if (value() === 'async') { isAsync = true; index += 1; }
      if (['get', 'set'].includes(value()) && peek(1) && peek(1).type === 'identifier') index += 1;
      if (value() === '#') index += 1;
      const nameToken = identifier();
      if (value() === '(') {
        const params = parseParams();
        const body = parseBlock();
        methods.push({ type: 'MethodDefinition', name: nameToken.value, line: nameToken.line, column: nameToken.column, params, body, static: isStatic, async: isAsync, start: methodStart.start, end: body.end, endLine: body.endLine });
      } else {
        skipStatement();
      }
    }
    expect('}');
    const endToken = tokens[index - 1];
    return node('ClassDeclaration', start, { name: nameToken.value, id: nameToken, parent, methods, exported, end: endToken.end, endLine: endToken.line });
  };

  const body = [];
  while (index < tokens.length) {
    const token = peek();
    if (!token) break;
    if (token.value === ';') { index += 1; continue; }
    if (token.value === 'export') {
      index += 1;
      if (value() === 'default') { index += 1; const next = peek(); if (value() === 'function') { body.push(parseFunction(next, { exported: true })); continue; } if (value() === 'class') { body.push(parseClass(next, { exported: true })); continue; } skipStatement(); continue; }
      if (value() === '{') { const close = matching(tokens, index); index = close + 1; continue; }
      if (value() === 'function') { body.push(parseFunction(token, { exported: true })); continue; }
      if (value() === 'class') { body.push(parseClass(token, { exported: true })); continue; }
      if (['const', 'let', 'var'].includes(value())) {
        const kind = value();
        index += 1;
        const nameToken = identifier();
        index += 1;
        let expression;
        if (value() === '(') {
          const close = matching(tokens, index);
          const params = [];
          for (let cursor = index + 1; cursor < close; cursor += 1) if (tokens[cursor].type === 'identifier' && !KEYWORDS.has(tokens[cursor].value)) params.push({ name: tokens[cursor].value, line: tokens[cursor].line, column: tokens[cursor].column });
          index = close + 1;
          if (value() === '=>') {
            index += 1;
            const block = value() === '{' ? parseBlock() : parseExpression();
            expression = node('ArrowFunctionExpression', nameToken, { params, body: block });
          } else expression = parseExpression();
        } else expression = parseExpression();
        body.push(node('VariableDeclaration', token, { kind, name: nameToken.value, id: nameToken, init: expression, exported: true, end: expression.end }));
        continue;
      }
      skipStatement();
      continue;
    }
    if (token.value === 'import') {
      const start = token;
      index += 1;
      const specifiers = [];
      let sourceValue = null;
      if (peek() && peek().type === 'string') {
        sourceValue = peek().value.slice(1, -1);
        index += 1;
      } else {
        while (index < tokens.length && value() !== 'from' && peek().type !== 'string') {
          if (peek().type === 'identifier' && !['as'].includes(value())) specifiers.push(peek().value);
          index += 1;
        }
        if (value() === 'from') index += 1;
        if (peek() && peek().type === 'string') { sourceValue = peek().value.slice(1, -1); index += 1; }
      }
      if (value() === ';') index += 1;
      body.push(node('ImportDeclaration', start, { source: sourceValue, specifiers }));
      continue;
    }
    if (token.value === 'async' && value(1) === 'function') { index += 1; body.push(parseFunction(token, { async: true })); continue; }
    if (token.value === 'function') { body.push(parseFunction(token)); continue; }
    if (token.value === 'class') { body.push(parseClass(token)); continue; }
    if (['const', 'let', 'var'].includes(token.value)) {
      index += 1;
      if (value() === '{' || value() === '[') {
        const open = value();
        const close = matching(tokens, index);
        const names = [];
        for (let cursor = index + 1; cursor < close; cursor += 1) {
          if (tokens[cursor].type === 'identifier' && !KEYWORDS.has(tokens[cursor].value)) names.push(tokens[cursor]);
        }
        index = close + 1;
        if (value() === '=') index += 1;
        const initExpression = parseExpression();
        for (const nameToken of names) body.push(node('VariableDeclaration', token, { kind: token.value, name: nameToken.value, id: nameToken, init: initExpression, destructured: open === '{' ? 'object' : 'array', end: initExpression.end }));
        continue;
      }
      const nameToken = identifier();
      let init = null;
      if (value() === '=') {
        index += 1;
        if (value() === 'async' && value(1) === 'function') { init = parseFunction(nameToken, { async: true, expression: true }); }
        else if (value() === 'function') { init = parseFunction(nameToken, { expression: true }); }
        else if (value() === 'async') { index += 1; init = parseExpression(); }
        else if (value() === 'class') { init = parseClass(nameToken, { expression: true }); }
        else if (value() === '(') {
          // Arrow function with a parenthesised parameter list.
          const close = matching(tokens, index);
          const params = [];
          for (let cursor = index + 1; cursor < close; cursor += 1) if (tokens[cursor].type === 'identifier' && !KEYWORDS.has(tokens[cursor].value)) params.push({ name: tokens[cursor].value, line: tokens[cursor].line, column: tokens[cursor].column });
          index = close + 1;
          if (value() === '=>') {
            index += 1;
            const block = value() === '{' ? parseBlock() : parseExpression();
            init = node('ArrowFunctionExpression', nameToken, { params, body: block });
          } else init = parseExpression();
        } else if (peek() && peek().type === 'identifier' && value(1) === '=>') {
          const param = peek(); index += 2;
          const block = value() === '{' ? parseBlock() : parseExpression();
          init = node('ArrowFunctionExpression', nameToken, { params: [{ name: param.value, line: param.line, column: param.column }], body: block });
        } else init = parseExpression();
      }
      if (value() === ';') index += 1;
      body.push(node('VariableDeclaration', token, { kind: token.value, name: nameToken.value, id: nameToken, init, end: init ? init.end : nameToken.end }));
      continue;
    }
    skipStatement();
  }
  return { type: 'Program', language: 'javascript', file, body, tokens, endLine: (tokens[tokens.length - 1] || { line: 1 }).line };
}

/** Python parser: indentation defines blocks; no invented nesting. */
function parsePython(source, { file = 'input.py' } = {}) {
  const physical = String(source).replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  let buffer = null;
  let depth = 0;
  let startedAt = 0;
  const balance = (line) => {
    let value = 0;
    let quote = null;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (quote) { if (char === '\\') index += 1; else if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if ('([{'.includes(char)) value += 1;
      else if (')]}'.includes(char)) value -= 1;
    }
    return value;
  };
  physical.forEach((line, index) => {
    if (buffer == null) { buffer = line; startedAt = index + 1; depth = 0; }
    else buffer = `${buffer} ${line.trim()}`;
    depth += balance(line);
    if (depth <= 0) { lines.push(buffer); buffer = null; depth = 0; }
  });
  if (buffer != null) lines.push(buffer);
  const lineNumbers = [];
  { let cursor = 0; for (const line of physical) { lineNumbers.push(cursor + 1); cursor += 1; } }
  const root = { indent: 0, body: [], pending: null };
  const frames = [root];
  const tokens = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const raw = lines[lineIndex];
    const expanded = raw.replace(/\t/g, '    ');
    if (!expanded.trim() || expanded.trim().startsWith('#')) continue;
    const indent = expanded.length - expanded.trimStart().length;
    const text = expanded.trim();
    const lineNumber = lineIndex + 1;
    if (indent === 0) frames.length = 1;
    while (frames.length > 1 && indent < frames[frames.length - 1].indent) frames.pop();
    if (indent > frames[frames.length - 1].indent) {
      const parent = frames[frames.length - 1];
      if (!parent.pending) throw fail('unexpected indentation', lineNumber, indent + 1);
      const block = parent.pending;
      parent.pending = null;
      frames.push({ indent, body: block, pending: null });
    }
    const current = frames[frames.length - 1];
    const lineToken = { type: 'line', value: text, line: lineNumber, column: indent + 1, start: 0, end: text.length };
    tokens.push(lineToken);
    const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\((.*)\)\s*(?:->[^:]+)?:/.exec(text);
    if (def) {
      const block = [];
      const functionNode = node('FunctionDeclaration', lineToken, { name: def[1], params: def[2].split(',').map((entry) => entry.trim().split(/[:=]/)[0].trim()).filter(Boolean).map((name) => ({ name })), body: block, endLine: lineNumber, async: /^async/.test(text) });
      current.body.push(functionNode);
      current.pending = block;
      continue;
    }
    const cls = /^class\s+([A-Za-z_]\w*)(?:\(([^)]*)\))?:/.exec(text);
    if (cls) {
      const block = [];
      const classNode = node('ClassDeclaration', lineToken, { name: cls[1], parent: cls[2] ? cls[2].trim() : null, methods: [], body: block, endLine: lineNumber });
      current.body.push(classNode);
      current.pending = block;
      continue;
    }
    const importFrom = /^from\s+([\w.]+)\s+import\s+(.+)$/.exec(text);
    if (importFrom) { current.body.push(node('ImportDeclaration', lineToken, { source: importFrom[1], specifiers: importFrom[2].split(',').map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean) })); continue; }
    const importPlain = /^import\s+(.+)$/.exec(text);
    if (importPlain) { current.body.push(node('ImportDeclaration', lineToken, { source: importPlain[1].split(',')[0].trim().split(/\s+/)[0], specifiers: [] })); continue; }
    const assignment = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(.+)$/.exec(text);
    if (assignment) { current.body.push(node('VariableDeclaration', lineToken, { name: assignment[1], kind: 'assignment' })); continue; }
    current.body.push(node('Expression', lineToken, { text }));
    if (/^(if|elif|else|for|while|try|except|finally|with|match|case)\b/.test(text) && text.endsWith(':')) {
      current.pending = [];
    }
  }
  return { type: 'Program', language: 'python', file, body: root.body, tokens, endLine: lines.length };
}

/** Brace/statement languages: structural declarations, no pretence of a full grammar. */
function parseBraceLanguage(source, language, { file = 'input' } = {}) {
  const tokens = tokenize(source, language);
  validateBalance(tokens);
  const body = [];
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const add = (type, name, line, extra = {}) => body.push({ type, name, line, column: 1, ...extra });
  lines.forEach((line, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const text = line.trim();
    if (!text) return;
    if (language === 'c' || language === 'cpp') {
      const include = /^#\s*include\s*[<"]([^">]+)[">]/.exec(text);
      if (include) add('ImportDeclaration', include[1], lineNumber, { source: include[1], specifiers: [] });
      const namespace = /^namespace\s+([\w:]+)/.exec(text);
      if (namespace) add('NamespaceDeclaration', namespace[1], lineNumber);
    }
    if (language === 'csharp') {
      const using = /^using\s+([\w.]+)\s*;/.exec(text);
      if (using) add('ImportDeclaration', using[1], lineNumber, { source: using[1], specifiers: [] });
      const namespace = /^namespace\s+([\w.]+)/.exec(text);
      if (namespace) add('NamespaceDeclaration', namespace[1], lineNumber);
    }
    if (language === 'java') {
      const packageMatch = /^package\s+([\w.]+)\s*;/.exec(text);
      if (packageMatch) add('PackageDeclaration', packageMatch[1], lineNumber, { source: packageMatch[1] });
      const importMatch = /^import\s+(?:static\s+)?([\w.*]+)\s*;/.exec(text);
      if (importMatch) add('ImportDeclaration', importMatch[1], lineNumber, { source: importMatch[1], specifiers: [] });
    }
    if (language === 'powershell') {
      const functionMatch = /^function\s+([\w-]+)/i.exec(text);
      if (functionMatch) add('FunctionDeclaration', functionMatch[1], lineNumber, { params: [], exported: true });
      const classMatch = /^class\s+([\w-]+)/i.exec(text);
      if (classMatch) add('ClassDeclaration', classMatch[1], lineNumber, { methods: [] });
      const usingMatch = /^using\s+(?:module|namespace)\s+([\w.]+)/i.exec(text);
      if (usingMatch) add('ImportDeclaration', usingMatch[1], lineNumber, { source: usingMatch[1], specifiers: [] });
    }
    const classMatch = /(?:^|\s)(?:class|struct|interface|enum)\s+([\w]+)/.exec(text);
    if (classMatch) add('ClassDeclaration', classMatch[1], lineNumber);
    if (language === 'java') {
      const method = /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],\s]+\s+([\w]+)\s*\(([^)]*)\)\s*(?:throws[^{]+)?\{?/.exec(text);
      if (method && !/^(if|for|while|switch|catch)$/.test(method[1])) add('FunctionDeclaration', method[1], lineNumber, { params: method[2].split(',').map((entry) => entry.trim().split(/\s+/).pop()).filter(Boolean).map((name) => ({ name })) });
    }
    if (language === 'c' || language === 'cpp') {
      const method = /^(?:[\w:*&<>,~]+\s+)+([A-Za-z_]\w*)\s*\(([^;]*)\)\s*(?:const\s*)?\{/.exec(text);
      if (method && !/^(if|for|while|switch|catch)$/.test(method[1])) add('FunctionDeclaration', method[1], lineNumber, { params: method[2].split(',').map((entry) => entry.trim().split(/\s+/).pop()).filter(Boolean).map((name) => ({ name })) });
    }
    if (language === 'csharp') {
      const method = /(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?[\w<>\[\],\s]+\s+([\w]+)\s*\(([^)]*)\)\s*\{?/.exec(text);
      if (method && !/^(if|for|while|switch|catch)$/.test(method[1])) add('FunctionDeclaration', method[1], lineNumber, { params: method[2].split(',').map((entry) => entry.trim().split(/\s+/).pop()).filter(Boolean).map((name) => ({ name })) });
    }
  });
  return { type: 'Program', language, file, body, tokens, endLine: lines.length };
}

/** SQL parser: statement-level AST with table/column references. */
function parseSql(source, { file = 'input.sql' } = {}) {
  const text = String(source);
  const statements = [];
  let start = 0;
  let quote = null;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index];
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ';' || index === text.length) {
      const chunk = text.slice(start, index).trim();
      if (chunk) {
        const line = text.slice(0, start).split('\n').length;
        const type = /^(select|insert|update|delete|create|alter|drop|with)\b/i.exec(chunk);
        const tables = [];
        for (const match of chunk.matchAll(/\b(?:from|join|into|update|table)\s+([A-Za-z_][\w.]*)/gi)) tables.push(match[1]);
        const columns = [];
        for (const match of chunk.matchAll(/\b(?:select|where|set|order by|group by|on)\b([\s\S]*?)(?=\bfrom\b|\bwhere\b|\bgroup\b|\border\b|\blimit\b|$)/gi)) {
          for (const column of match[1].split(',')) {
            const name = column.trim().replace(/^(?:distinct|all)\s+/i, '').split(/\s+/)[0];
            if (/^[A-Za-z_][\w.]*$/.test(name) && !['*', 'and', 'or'].includes(name.toLowerCase())) columns.push(name);
          }
        }
        statements.push({ type: 'SqlStatement', kind: type ? type[1].toUpperCase() : 'OTHER', line, text: chunk.slice(0, 500), tables: [...new Set(tables)], columns: [...new Set(columns)] });
      }
      start = index + 1;
    }
  }
  return { type: 'Program', language: 'sql', file, body: statements, tokens: [], endLine: text.split('\n').length };
}

function parse(source, { file = 'input', language = null } = {}) {
  const chosen = language || detectLanguage(file);
  if (!chosen) throw fail(`no parser for ${file}`, 1, 1, 'UNSUPPORTED_LANGUAGE');
  if (chosen === 'javascript' || chosen === 'typescript') return parseJavaScript(source, { file });
  if (chosen === 'python') return parsePython(source, { file });
  if (chosen === 'sql') return parseSql(source, { file });
  if (['c', 'cpp', 'csharp', 'java', 'powershell'].includes(chosen)) return parseBraceLanguage(source, chosen, { file });
  throw fail(`no parser for ${chosen}`, 1, 1, 'UNSUPPORTED_LANGUAGE');
}

/** Walks every AST child object that looks like a node. */
function walk(ast, visitor, parent = null) {
  if (!ast || typeof ast !== 'object') return;
  if (ast.type) visitor(ast, parent);
  for (const [key, value] of Object.entries(ast)) {
    if (['tokens', 'text'].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child && child.type) walk(child, visitor, ast);
    } else if (value && value.type) {
      walk(value, visitor, ast);
    }
  }
}

function parseFile(file, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const stat = fs.statSync(file);
  if (stat.size > maxBytes) throw fail(`file is larger than ${maxBytes} bytes`, 1, 1, 'TOO_LARGE');
  const source = fs.readFileSync(file, 'utf8');
  return parse(source, { file });
}

module.exports = { parse, parseJavaScript, parsePython, parseBraceLanguage, parseSql, parseFile, tokenize, walk, detectLanguage, fail, LANGUAGE_BY_EXTENSION };
