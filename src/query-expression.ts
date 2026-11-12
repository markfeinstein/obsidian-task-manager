/** A parsed, deliberately restricted expression. No eval, dynamic code, or prototype lookup. */
export type QueryExpression = (scope: Record<string, unknown>) => unknown;

type Token = { type: 'identifier' | 'string' | 'number' | 'regex' | 'operator' | 'punctuation'; value: string };

export interface QueryExpressionOperations {
  property(target: unknown, name: string): unknown;
  method(target: unknown, name: string, args: unknown[]): unknown;
  call(name: string, args: unknown[]): unknown;
  regex(value: string): RegExp;
  truthy(value: unknown): boolean;
  equal(left: unknown, right: unknown): boolean;
  compare(left: unknown, right: unknown): number;
}

export function compileQueryExpression(expression: string, operations: QueryExpressionOperations): QueryExpression {
  return new ExpressionParser(tokenize(expression), operations).parse();
}

class ExpressionParser {
  private position = 0;

  constructor(private readonly tokens: readonly Token[], private readonly operations: QueryExpressionOperations) {}

  parse(): QueryExpression {
    const expression = this.parseOr();
    if (this.peek()) throw new Error(`Unexpected token '${this.peek()?.value}'.`);
    return expression;
  }

  private parseOr(): QueryExpression {
    let left = this.parseAnd();
    while (this.consume('||')) {
      const lhs = left;
      const right = this.parseAnd();
      left = (scope) => {
        const a = lhs(scope);
        const b = right(scope);
        return this.operations.truthy(a) || this.operations.truthy(b);
      };
    }
    return left;
  }

  private parseAnd(): QueryExpression {
    let left = this.parseEquality();
    while (this.consume('&&')) {
      const lhs = left;
      const right = this.parseEquality();
      left = (scope) => {
        const a = lhs(scope);
        const b = right(scope);
        return this.operations.truthy(a) && this.operations.truthy(b);
      };
    }
    return left;
  }

  private parseEquality(): QueryExpression {
    let left = this.parseComparison();
    while (this.peek()?.type === 'operator' && ['===', '==', '!==', '!='].includes(this.peek()?.value ?? '')) {
      const operator = this.advance()?.value;
      const lhs = left;
      const right = this.parseComparison();
      left = (scope) => operator === '===' || operator === '=='
        ? this.operations.equal(lhs(scope), right(scope))
        : !this.operations.equal(lhs(scope), right(scope));
    }
    return left;
  }

  private parseComparison(): QueryExpression {
    let left = this.parseUnary();
    while (this.peek()?.type === 'operator' && ['>', '>=', '<', '<='].includes(this.peek()?.value ?? '')) {
      const operator = this.advance()?.value;
      const lhs = left;
      const right = this.parseUnary();
      left = (scope) => {
        const comparison = this.operations.compare(lhs(scope), right(scope));
        return operator === '>' ? comparison > 0 : operator === '>=' ? comparison >= 0 : operator === '<' ? comparison < 0 : comparison <= 0;
      };
    }
    return left;
  }

  private parseUnary(): QueryExpression {
    if (this.consume('!')) {
      const expression = this.parseUnary();
      return (scope) => !this.operations.truthy(expression(scope));
    }
    if (this.consume('-')) {
      const expression = this.parseUnary();
      return (scope) => -Number(expression(scope));
    }
    return this.parsePostfix();
  }

  private parsePostfix(): QueryExpression {
    let value = this.parsePrimary();
    while (this.consume('.')) {
      const name = this.advance();
      if (name?.type !== 'identifier') throw new Error('Expected identifier.');
      const target = value;
      if (this.consume('(')) {
        const args = this.parseArguments();
        value = (scope) => this.operations.method(target(scope), name.value, args.map((arg) => arg(scope)));
      } else value = (scope) => this.operations.property(target(scope), name.value);
    }
    return value;
  }

  private parsePrimary(): QueryExpression {
    if (this.consume('(')) {
      const value = this.parseOr();
      this.expect(')');
      return value;
    }
    const token = this.advance();
    if (!token) throw new Error('Unexpected end of expression.');
    if (token.type === 'string') return () => token.value;
    if (token.type === 'number') return () => Number(token.value);
    // Keep regular expressions request-local so global/sticky lastIndex never leaks between tasks.
    if (token.type === 'regex') return () => this.operations.regex(token.value);
    if (token.type === 'identifier') {
      if (token.value === 'true') return () => true;
      if (token.value === 'false') return () => false;
      if (token.value === 'null') return () => null;
      if (token.value === 'undefined') return () => undefined;
      if (this.consume('(')) {
        const args = this.parseArguments();
        return (scope) => this.operations.call(token.value, args.map((arg) => arg(scope)));
      }
      return (scope) => this.operations.property(scope, token.value);
    }
    throw new Error(`Unexpected token '${token.value}'.`);
  }

  private parseArguments(): QueryExpression[] {
    const args: QueryExpression[] = [];
    if (this.consume(')')) return args;
    do args.push(this.parseOr()); while (this.consume(','));
    this.expect(')');
    return args;
  }

  private consume(value: string): boolean {
    const token = this.peek();
    const type = ['(', ')', '.', ','].includes(value) ? 'punctuation' : 'operator';
    if (token?.type !== type || token.value !== value) return false;
    this.position += 1;
    return true;
  }
  private expect(value: string): void { if (!this.consume(value)) throw new Error(`Expected '${value}'.`); }
  private advance(): Token | undefined { return this.tokens[this.position++]; }
  private peek(): Token | undefined { return this.tokens[this.position]; }
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < expression.length;) {
    const char = expression[index];
    if (/\s/u.test(char)) { index += 1; continue; }
    const operator = expression.slice(index).match(/^(?:===|!==|&&|\|\||==|!=|>=|<=|[!><-])/u)?.[0];
    if (operator) { tokens.push({ type: 'operator', value: operator }); index += operator.length; continue; }
    if (['(', ')', '.', ','].includes(char)) { tokens.push({ type: 'punctuation', value: char }); index += 1; continue; }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      index += 1;
      while (index < expression.length && expression[index] !== quote) {
        if (expression[index] === '\\' && index + 1 < expression.length) { value += expression[index + 1]; index += 2; }
        else { value += expression[index]; index += 1; }
      }
      if (expression[index] !== quote) throw new Error('Unclosed string in query DSL expression.');
      tokens.push({ type: 'string', value });
      index += 1;
      continue;
    }
    if (char === '/') {
      let value = '/';
      index += 1;
      while (index < expression.length) {
        const current = expression[index++];
        value += current;
        if (current === '\\' && index < expression.length) { value += expression[index++]; continue; }
        if (current === '/') {
          while (index < expression.length && /[a-z]/iu.test(expression[index])) value += expression[index++].toLowerCase();
          break;
        }
      }
      tokens.push({ type: 'regex', value });
      continue;
    }
    const number = expression.slice(index).match(/^\d+(?:\.\d+)?/u)?.[0];
    if (number) { tokens.push({ type: 'number', value: number }); index += number.length; continue; }
    const identifier = expression.slice(index).match(/^[A-Za-z_$][\w$]*/u)?.[0];
    if (identifier) { tokens.push({ type: 'identifier', value: identifier }); index += identifier.length; continue; }
    throw new Error(`Unsupported query DSL character '${char}'.`);
  }
  return tokens;
}
