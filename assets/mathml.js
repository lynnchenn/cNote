/*!
 * cNote 数学渲染器——把实用的 LaTeX 子集转换为 MathML，由 Chromium 原生渲染。
 * 这样应用无需任何第三方依赖（不打包 KaTeX）。
 */
(function (global) {
  'use strict';

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var SYMBOLS = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
    eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
    xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
    upsilon: 'υ', phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
    Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', div: '÷', cdot: '⋅', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘',
    bullet: '∙', oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘', odot: '⊙',
    le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', equiv: '≡', approx: '≈',
    sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', doteq: '≐',
    subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', in: '∈', notin: '∉',
    ni: '∋', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
    forall: '∀', exists: '∃', nexists: '∄', neg: '¬', land: '∧', lor: '∨',
    to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒',
    Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
    longrightarrow: '⟶', longleftarrow: '⟵', implies: '⟹', iff: '⟺',
    infty: '∞', partial: '∂', nabla: '∇', surd: '√', angle: '∠', perp: '⊥', parallel: '∥',
    triangle: '△', square: '□', diamond: '◇', deg: '°', prime: '′', backslash: '\\',
    ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…',
    aleph: 'ℵ', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', wp: '℘',
    lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', langle: '⟨', rangle: '⟩',
    lvert: '|', rvert: '|', lVert: '‖', rVert: '‖', vert: '|', Vert: '‖',
  };

  var BIG_OPS = {
    sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
    bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀', bigoplus: '⨁', bigotimes: '⨂',
    bigodot: '⨀', bigsqcup: '⨆', lim: 'lim', limsup: 'lim sup', liminf: 'lim inf',
  };

  var FUNCTIONS = {
    sin: 1, cos: 1, tan: 1, cot: 1, sec: 1, csc: 1, arcsin: 1, arccos: 1, arctan: 1,
    sinh: 1, cosh: 1, tanh: 1, coth: 1, log: 1, ln: 1, lg: 1, exp: 1, det: 1, dim: 1,
    ker: 1, hom: 1, arg: 1, gcd: 1, lcm: 1,
  };

  var ACCENTS = {
    hat: '\u0302', widehat: '\u0302', bar: '\u0304', overline: '\u0305',
    tilde: '\u0303', widetilde: '\u0303', vec: '\u20d7', dot: '\u0307',
    ddot: '\u0308', check: '\u030c', breve: '\u0306', acute: '\u0301', grave: '\u0300',
  };

  var SPACES = {
    ',': '0.167em', ':': '0.222em', '>': '0.222em', ';': '0.278em', '!': '-0.167em',
    ' ': '0.333em', '.': '0em',
  };

  var QUAD = { quad: '1em', qquad: '2em' };

  var DELIMITERS = { '{': '{', '}': '}', '|': '|', '.': '', '(': '(', ')': ')' };

  var LETTER = /[a-zA-Z]/;

  // ------------------------------------------------------------------ 词法

  function lex(source) {
    var tokens = [];
    var text = String(source);
    var i = 0;

    while (i < text.length) {
      var ch = text[i];

      if (ch === '\\') {
        var nameMatch = /^\\([a-zA-Z]+)/.exec(text.slice(i));
        if (nameMatch) {
          tokens.push({ type: 'cmd', v: nameMatch[1] });
          i += nameMatch[0].length;
          continue;
        }
        tokens.push({ type: 'cmd', v: text[i + 1] || '' });
        i += 2;
        continue;
      }

      if (ch === '{') { tokens.push({ type: 'open' }); i++; continue; }
      if (ch === '}') { tokens.push({ type: 'close' }); i++; continue; }
      if (ch === '^') { tokens.push({ type: 'sup' }); i++; continue; }
      if (ch === '_') { tokens.push({ type: 'sub' }); i++; continue; }
      if (ch === '&') { tokens.push({ type: 'align' }); i++; continue; }
      if (ch === '~') { tokens.push({ type: 'space', w: '0.333em' }); i++; continue; }
      if (/\s/.test(ch)) { i++; continue; }

      tokens.push({ type: 'char', v: ch });
      i++;
    }

    return tokens;
  }

  // ----------------------------------------------------------------- 解析

  function Parser(tokens, display) {
    this.tokens = tokens;
    this.i = 0;
    this.display = display;
  }

  Parser.prototype.peek = function (offset) {
    return this.tokens[this.i + (offset || 0)];
  };

  Parser.prototype.parseRow = function (isStop) {
    var items = [];
    while (this.i < this.tokens.length) {
      var token = this.peek();
      if (isStop && isStop(token)) { break; }
      if (token.type === 'close') { break; }
      var node = this.parseScripted();
      if (!node) { break; }
      items.push(node);
    }
    return items.length === 1 ? items[0] : { t: 'row', items: items };
  };

  Parser.prototype.parseGroup = function () {
    if (this.peek() && this.peek().type === 'open') {
      this.i++;
      var row = this.parseRow(function (token) { return token.type === 'close'; });
      if (this.peek() && this.peek().type === 'close') { this.i++; }
      return row;
    }
    return this.parseAtom();
  };

  Parser.prototype.parseScripted = function () {
    var base = this.parseAtom();
    if (!base) { return null; }

    var sub = null;
    var sup = null;

    for (;;) {
      var token = this.peek();
      if (!token) { break; }
      if (token.type === 'sub') { this.i++; sub = this.parseGroup(); continue; }
      if (token.type === 'sup') { this.i++; sup = this.parseGroup(); continue; }
      break;
    }

    if (!sub && !sup) { return base; }

    var limitStyle = base.t === 'bigop' && (this.display || base.forceLimits) && base.forceLimits !== 'inline';

    if (sub && sup) {
      return { t: limitStyle ? 'underover' : 'subsup', base: base, sub: sub, sup: sup };
    }
    if (sup) { return { t: limitStyle ? 'over' : 'sup', base: base, sup: sup }; }
    return { t: limitStyle ? 'under' : 'sub', base: base, sub: sub };
  };

  Parser.prototype.parseAtom = function () {
    var token = this.peek();
    if (!token) { return null; }

    if (token.type === 'open') {
      this.i++;
      var row = this.parseRow(function (tk) { return tk.type === 'close'; });
      if (this.peek() && this.peek().type === 'close') { this.i++; }
      return row;
    }

    if (token.type === 'space') {
      this.i++;
      return { t: 'space', w: token.w };
    }

    if (token.type === 'align' || token.type === 'close') { return null; }

    if (token.type === 'char') {
      this.i++;
      return classifyChar(token.v);
    }

    if (token.type !== 'cmd') { this.i++; return null; }
    this.i++;

    var name = token.v;

    if (name === '\\') { return { t: 'newline' }; }

    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      return { t: 'frac', num: this.parseGroup(), den: this.parseGroup() };
    }

    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
      return { t: 'binom', num: this.parseGroup(), den: this.parseGroup() };
    }

    if (name === 'sqrt') {
      var index = null;
      if (this.peek() && this.peek().type === 'char' && this.peek().v === '[') {
        this.i++;
        index = this.parseRow(function (tk) { return tk.type === 'char' && tk.v === ']'; });
        if (this.peek() && this.peek().type === 'char' && this.peek().v === ']') { this.i++; }
      }
      return { t: 'sqrt', body: this.parseGroup(), index: index };
    }

    if (name === 'text' || name === 'textrm' || name === 'textnormal' || name === 'mbox' ||
        name === 'operatorname' || name === 'textsf' || name === 'texttt') {
      return { t: 'text', v: readRawGroup(this) };
    }

    if (name === 'mathbf' || name === 'boldsymbol' || name === 'bm' || name === 'pmb') {
      return { t: 'styled', variant: 'bold', body: this.parseGroup() };
    }
    if (name === 'mathit' || name === 'mathrm' || name === 'mathsf' || name === 'mathtt' ||
        name === 'mathcal' || name === 'mathbb' || name === 'mathfrak' || name === 'mathnormal') {
      var variant = name === 'mathcal' ? 'script' : (name === 'mathbb' ? 'double-struck' : 'normal');
      return { t: 'styled', variant: variant, body: this.parseGroup() };
    }

    if (name === 'left' || name === 'right') {
      var delimiter = readDelimiter(this);
      if (!delimiter) { return null; }
      return { t: 'mo', v: delimiter, stretchy: true, fence: true };
    }

    if (name === 'begin') { return this.parseEnvironment(readRawGroup(this).trim()); }
    if (name === 'end') { readRawGroup(this); return null; }

    if (name === 'overbrace' || name === 'underbrace') {
      return { t: 'accent', v: name === 'overbrace' ? '\u23de' : '\u23df', body: this.parseGroup() };
    }
    if (name === 'underline') { return { t: 'accent', v: '\u0332', body: this.parseGroup() }; }
    if (ACCENTS[name]) { return { t: 'accent', v: ACCENTS[name], body: this.parseGroup() }; }

    if (SPACES[name] != null) { return { t: 'space', w: SPACES[name] }; }
    if (QUAD[name]) { return { t: 'space', w: QUAD[name] }; }

    if (BIG_OPS[name]) {
      return { t: 'bigop', v: BIG_OPS[name], forceLimits: name.indexOf('lim') === 0 };
    }

    if (FUNCTIONS[name]) { return { t: 'mo', v: name, func: true }; }

    if (name === 'limits' || name === 'nolimits' || name === 'displaystyle' || name === 'textstyle' ||
        name === 'scriptstyle' || name === 'scriptscriptstyle' || name === 'mathord' ||
        name === 'mathrel' || name === 'mathbin' || name === 'mathop' || name === 'mathpunct' ||
        name === 'mathopen' || name === 'mathclose' || name === 'mathinner' || name === 'label') {
      var next = this.parseAtom();
      return next || { t: 'space', w: '0em' };
    }

    if (name === 'color' || name === 'textcolor' || name === 'class' || name === 'style' || name === 'htmlClass') {
      readRawGroup(this);
      return this.parseGroup();
    }

    if (name === 'phantom' || name === 'vphantom' || name === 'hphantom' || name === 'rule') {
      if (name === 'rule') { readRawGroup(this); readRawGroup(this); }
      else { readRawGroup(this); }
      return { t: 'space', w: '0.5em' };
    }

    if (SYMBOLS[name] != null) { return { t: 'mo', v: SYMBOLS[name] }; }

    // 未知命令：保留字母显示，而不是直接丢弃。
    return { t: 'mi', v: name };
  };

  Parser.prototype.parseEnvironment = function (env) {
    var rows = [[]];

    while (this.i < this.tokens.length) {
      var token = this.peek();

      if (token.type === 'cmd' && token.v === 'end') {
        this.i++;
        readRawGroup(this);
        break;
      }
      if (token.type === 'cmd' && token.v === '\\') {
        this.i++;
        rows.push([]);
        continue;
      }
      if (token.type === 'align') { this.i++; continue; }

      var node = this.parseScripted();
      if (!node) { this.i++; continue; }
      rows[rows.length - 1].push(node);
    }

    var open = '';
    var close = '';
    if (env === 'pmatrix' || env === 'matrix' || env === 'smallmatrix') { open = '('; close = ')'; }
    else if (env === 'bmatrix') { open = '['; close = ']'; }
    else if (env === 'vmatrix') { open = '|'; close = '|'; }
    else if (env === 'Bmatrix') { open = '{'; close = '}'; }
    else if (env === 'Vmatrix') { open = '‖'; close = '‖'; }
    else if (env === 'cases') { open = '{'; }
    if (env === 'matrix' || env === 'smallmatrix') { open = ''; close = ''; }

    return { t: 'mtable', rows: rows, open: open, close: close };
  };

  function readRawGroup(parser) {
    var token = parser.peek();
    if (!token || token.type !== 'open') { return ''; }
    parser.i++;
    var depth = 1;
    var out = '';
    while (parser.i < parser.tokens.length) {
      var current = parser.tokens[parser.i];
      if (current.type === 'open') { depth++; out += '{'; parser.i++; continue; }
      if (current.type === 'close') {
        depth--;
        parser.i++;
        if (depth === 0) { break; }
        out += '}';
        continue;
      }
      out += tokenText(current);
      parser.i++;
    }
    return out;
  }

  function tokenText(token) {
    if (token.type === 'cmd') { return token.v.length > 1 ? '\\' + token.v : token.v; }
    if (token.type === 'char') { return token.v; }
    if (token.type === 'open') { return '{'; }
    if (token.type === 'close') { return '}'; }
    if (token.type === 'sup') { return '^'; }
    if (token.type === 'sub') { return '_'; }
    if (token.type === 'align') { return '&'; }
    if (token.type === 'space') { return ' '; }
    return '';
  }

  function readDelimiter(parser) {
    var token = parser.peek();
    if (!token) { return ''; }
    parser.i++;
    if (token.type === 'char') {
      return DELIMITERS[token.v] != null ? DELIMITERS[token.v] : token.v;
    }
    if (token.type === 'cmd') { return SYMBOLS[token.v] || ''; }
    return '';
  }

  function classifyChar(ch) {
    if (/[0-9]/.test(ch)) { return { t: 'mn', v: ch }; }
    if (LETTER.test(ch)) { return { t: 'mi', v: ch }; }
    if (/[+\-*/=<>±×÷≤≥≠≈∈∉⊂⊆∪∩→←↔]/.test(ch)) { return { t: 'mo', v: ch }; }
    if (/[()\[\]{}|]/.test(ch)) { return { t: 'mo', v: ch, fence: true }; }
    if (ch === ',' || ch === '.' || ch === ';' || ch === ':') { return { t: 'mo', v: ch }; }
    return { t: 'mo', v: ch };
  }

  // ---------------------------------------------------------------- 渲染

  function renderNode(node) {
    if (!node) { return ''; }

    switch (node.t) {
      case 'row':
        if (!node.items.length) { return '<mrow></mrow>'; }
        return '<mrow>' + node.items.map(renderNode).join('') + '</mrow>';

      case 'mi':
        return '<mi>' + esc(node.v) + '</mi>';

      case 'mn':
        return '<mn>' + esc(node.v) + '</mn>';

      case 'mo': {
        var attributes = '';
        if (node.stretchy) { attributes += ' stretchy="true"'; }
        if (node.fence) { attributes += ' fence="true"'; }
        if (node.func) { attributes += ' lspace="0em" rspace="0.15em"'; }
        return '<mo' + attributes + '>' + esc(node.v) + '</mo>';
      }

      case 'text':
        return '<mtext>' + esc(node.v) + '</mtext>';

      case 'space':
        return '<mspace width="' + esc(node.w) + '"></mspace>';

      case 'newline':
        return '<mspace linebreak="newline"></mspace>';

      case 'frac':
        return '<mfrac>' + wrap(node.num) + wrap(node.den) + '</mfrac>';

      case 'binom':
        return '<mrow><mo fence="true">(</mo><mfrac linethickness="0">' +
          wrap(node.num) + wrap(node.den) + '</mfrac><mo fence="true">)</mo></mrow>';

      case 'sqrt':
        return node.index
          ? '<mroot>' + wrap(node.body) + wrap(node.index) + '</mroot>'
          : '<msqrt>' + wrap(node.body) + '</msqrt>';

      case 'sup':
        return '<msup>' + wrap(node.base) + wrap(node.sup) + '</msup>';

      case 'sub':
        return '<msub>' + wrap(node.base) + wrap(node.sub) + '</msub>';

      case 'subsup':
        return '<msubsup>' + wrap(node.base) + wrap(node.sub) + wrap(node.sup) + '</msubsup>';

      case 'over':
        return '<mover>' + wrap(node.base) + wrap(node.sup) + '</mover>';

      case 'under':
        return '<munder>' + wrap(node.base) + wrap(node.sub) + '</munder>';

      case 'underover':
        return '<munderover>' + wrap(node.base) + wrap(node.sub) + wrap(node.sup) + '</munderover>';

      case 'accent':
        return '<mover accent="true">' + wrap(node.body) + '<mo>' + esc(node.v) + '</mo></mover>';

      case 'styled':
        return '<mstyle mathvariant="' + esc(node.variant) + '">' + wrap(node.body) + '</mstyle>';

      case 'bigop':
        return '<mo largeop="true" movablelimits="true">' + esc(node.v) + '</mo>';

      case 'mtable': {
        var rows = node.rows.map(function (cells) {
          return '<mtr>' + cells.map(function (cell) {
            return '<mtd>' + wrap(cell) + '</mtd>';
          }).join('') + '</mtr>';
        }).join('');
        var table = '<mtable>' + rows + '</mtable>';
        if (!node.open && !node.close) { return table; }
        return '<mrow><mo fence="true" stretchy="true">' + esc(node.open) + '</mo>' + table +
          '<mo fence="true" stretchy="true">' + esc(node.close) + '</mo></mrow>';
      }

      default:
        return '';
    }
  }

  function wrap(node) {
    var html = renderNode(node);
    return html || '<mrow></mrow>';
  }

  function render(tex, display) {
    var source = String(tex == null ? '' : tex).trim();
    if (!source) { return ''; }

    try {
      var parser = new Parser(lex(source), !!display);
      var tree = parser.parseRow(null);
      var body = renderNode(tree) || '<mrow></mrow>';
      return '<math xmlns="http://www.w3.org/1998/Math/MathML" display="' +
        (display ? 'block' : 'inline') + '">' + body + '</math>';
    } catch (error) {
      return '<code class="md-math-raw">' + esc(source) + '</code>';
    }
  }

  global.MathML = { render: render };
})(window);
