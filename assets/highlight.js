/*!
 * cNote 语法高亮器——紧凑、无依赖的词法分析器，覆盖 Markdown 笔记中会出现的
 * 各种语言。未知语言会回退到 C 系语言扫描器，而不是直接失败。
 */
(function (global) {
  'use strict';

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function span(kind, text) {
    return '<span class="tok-' + kind + '">' + esc(text) + '</span>';
  }

  var C_KEYWORDS =
    'if else for while do return break continue switch case default goto sizeof typedef struct union enum ' +
    'static const extern inline volatile register signed unsigned void auto';
  var C_TYPES = 'int char short long float double size_t bool';
  var C_LITERALS = 'true false null NULL nullptr';

  var LANGUAGES = {
    generic: {
      keywords: C_KEYWORDS + ' ' + C_TYPES,
      literals: C_LITERALS,
      line: '//', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    c: {
      keywords: C_KEYWORDS, types: C_TYPES, literals: C_LITERALS,
      line: '//', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    cpp: {
      keywords: C_KEYWORDS + ' class namespace template typename public private protected virtual override new delete' +
        ' try catch throw using constexpr noexcept auto decltype this operator friend explicit mutable',
      types: C_TYPES + ' string vector map set unique_ptr shared_ptr ostream istream',
      literals: C_LITERALS,
      line: '//', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    csharp: {
      keywords: 'abstract as base break case catch checked class const continue default delegate do else enum event' +
        ' explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new' +
        ' operator out override params private protected public readonly ref return sealed sizeof stackalloc static' +
        ' struct switch this throw try typeof unchecked unsafe using virtual volatile while yield async await var' +
        ' when where record init get set value partial nameof',
      types: 'int uint long ulong short ushort byte sbyte float double decimal bool char string object void dynamic' +
        ' nint nuint Task List Dictionary IEnumerable',
      literals: 'true false null default',
      line: '//', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    java: {
      keywords: 'abstract assert break case catch class const continue default do else enum extends final finally' +
        ' for goto if implements import instanceof interface native new package private protected public return' +
        ' static strictfp super switch synchronized this throw throws transient try volatile while var yield record sealed',
      types: 'boolean byte char double float int long short void String Integer Long Double Float Boolean Object List Map Set',
      literals: 'true false null',
      line: '//', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    js: {
      keywords: 'async await break case catch class const continue debugger default delete do else export extends' +
        ' finally for from function get if import in instanceof let new of return set static super switch this throw' +
        ' try typeof var void while with yield as satisfies keyof infer readonly declare namespace type interface enum implements',
      types: 'string number boolean symbol bigint any unknown never object void Array Object Promise Map Set Date RegExp' +
        ' Error JSON Math Number String Boolean Function Record Partial Omit Pick',
      literals: 'true false null undefined NaN Infinity this',
      builtins: 'console window document require module exports process globalThis fetch setTimeout setInterval localStorage',
      line: '//', block: ['/*', '*/'], quotes: '"\u0027`', escape: '\\',
    },
    python: {
      keywords: 'and as assert async await break class continue def del elif else except finally for from global if' +
        ' import in is lambda nonlocal not or pass raise return try while with yield match case',
      types: 'int float complex bool str bytes list tuple dict set frozenset object type',
      literals: 'True False None self cls',
      builtins: 'print len range enumerate zip map filter sum min max abs sorted open isinstance getattr setattr' +
        ' super staticmethod classmethod property repr format',
      line: '#', block: null, quotes: '"\u0027', escape: '\\', triple: true,
    },
    ruby: {
      keywords: 'alias and begin break case class def defined do else elsif end ensure false for if in module next' +
        ' nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor',
      types: 'String Integer Float Array Hash Symbol Proc',
      literals: 'true false nil self',
      line: '#', block: ['=begin', '=end'], quotes: '"\u0027', escape: '\\',
    },
    rust: {
      keywords: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop' +
        ' match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
      types: 'i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 usize isize f32 f64 bool char str String Vec Option Result Box Rc Arc',
      literals: 'true false None Some Ok Err',
      builtins: 'println print vec format panic assert dbg todo unwrap',
      line: '//', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    go: {
      keywords: 'break case chan const continue default defer else fallthrough for func go goto if import interface' +
        ' map package range return select struct switch type var',
      types: 'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8' +
        ' uint16 uint32 uint64 uintptr any',
      literals: 'true false nil iota',
      builtins: 'append cap close copy delete len make new panic print println recover',
      line: '//', block: ['/*', '*/'], quotes: '"\u0027`', escape: '\\',
    },
    php: {
      keywords: 'abstract and array as break callable case catch class clone const continue declare default do echo' +
        ' else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for' +
        ' foreach function global goto if implements include include_once instanceof insteadof interface isset list' +
        ' match namespace new or print private protected public readonly require require_once return static switch' +
        ' throw trait try unset use var while xor yield',
      types: 'bool int float string array object mixed void null callable iterable',
      literals: 'true false null',
      builtins: 'echo print_r var_dump count strlen array_map array_filter json_encode json_decode',
      line: '//', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    kotlin: {
      keywords: 'abstract actual annotation as break by catch class companion const constructor continue crossinline' +
        ' data delegate do dynamic else enum expect external final finally for fun get if import in infix init inline' +
        ' inner interface internal is lateinit noinline object open operator out override package private protected' +
        ' public reified return sealed set super suspend tailrec this throw typealias val var vararg when where while',
      types: 'Boolean Byte Char Double Float Int Long Short String Unit Any Nothing List Map Set Array',
      literals: 'true false null it',
      line: '//', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    swift: {
      keywords: 'associatedtype class deinit enum extension fileprivate func import init inout internal let open' +
        ' operator private protocol public rethrows static struct subscript typealias var break case continue default' +
        ' defer do else fallthrough for guard if in repeat return switch where while as any catch false is nil super' +
        ' self throw throws true try async await actor some',
      types: 'Bool Int Double Float String Character Array Dictionary Set Optional Void Any',
      literals: 'true false nil self',
      line: '//', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    bash: {
      keywords: 'if then else elif fi for while until do done case esac function in select return break continue' +
        ' local export readonly declare typeset unset shift source alias',
      literals: 'true false',
      builtins: 'echo printf cd ls cp mv rm mkdir rmdir touch cat grep sed awk find xargs chmod curl wget git npm' +
        ' docker sudo apt yum brew exit test read set',
      line: '#', block: null, quotes: '"\u0027', escape: '\\', variables: true,
    },
    powershell: {
      keywords: 'begin break catch class continue data define do dynamicparam else elseif end enum exit filter' +
        ' finally for foreach from function if in param process return switch throw trap try until using var while',
      literals: 'true false null',
      builtins: 'Write-Host Write-Output Get-ChildItem Get-Content Set-Content Select-Object Where-Object' +
        ' ForEach-Object Measure-Object Test-Path Join-Path Copy-Item Move-Item Remove-Item New-Item Start-Process',
      line: '#', block: ['<#', '#>'], quotes: '"\u0027', escape: '`', variables: true,
    },
    sql: {
      keywords: 'select from where insert into values update set delete create alter drop table view index database' +
        ' join left right inner outer full cross on group by having order limit offset union all distinct as and or' +
        ' not null is in between like exists case when then else end primary key foreign references default unique' +
        ' check constraint cascade transaction begin commit rollback with returning if add column',
      types: 'int integer bigint smallint tinyint decimal numeric float real char varchar nvarchar text date datetime' +
        ' timestamp time boolean blob json uuid serial',
      literals: 'true false null',
      builtins: 'count sum avg min max coalesce cast convert now current_date current_timestamp',
      line: '--', block: ['/*', '*/'], quotes: '"\u0027', escape: '\\',
    },
    ini: {
      keywords: '',
      literals: 'true false yes no on off null',
      line: '#', block: null, quotes: '"\u0027', escape: '\\', properties: true,
    },
  };

  LANGUAGES.typescript = LANGUAGES.js;
  LANGUAGES.javascript = LANGUAGES.js;
  LANGUAGES.sh = LANGUAGES.bash;
  LANGUAGES.shell = LANGUAGES.bash;
  LANGUAGES.console = LANGUAGES.bash;
  LANGUAGES.cs = LANGUAGES.csharp;
  LANGUAGES.cxx = LANGUAGES.cpp;
  LANGUAGES.rs = LANGUAGES.rust;
  LANGUAGES.golang = LANGUAGES.go;
  LANGUAGES.py = LANGUAGES.python;
  LANGUAGES.rb = LANGUAGES.ruby;
  LANGUAGES.kt = LANGUAGES.kotlin;
  LANGUAGES.yml = LANGUAGES.ini;
  LANGUAGES.toml = LANGUAGES.ini;
  LANGUAGES.conf = LANGUAGES.ini;
  LANGUAGES.properties = LANGUAGES.ini;
  LANGUAGES.yaml = LANGUAGES.ini;

  var ALIASES = {
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', javascript: 'js', typescript: 'js', ts: 'js', tsx: 'js',
    py: 'python', python3: 'python',
    sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
    ps1: 'powershell', pwsh: 'powershell',
    cs: 'csharp', 'c#': 'csharp',
    'c++': 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp',
    c: 'c', h: 'c',
    rs: 'rust',
    go: 'go', golang: 'go',
    rb: 'ruby',
    kt: 'kotlin', kts: 'kotlin',
    swift: 'swift',
    java: 'java',
    php: 'php',
    sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
    yml: 'ini', yaml: 'ini', toml: 'ini', ini: 'ini', conf: 'ini', env: 'ini', properties: 'ini', cfg: 'ini',
  };

  var DEDICATED = {
    json: json, jsonc: json, json5: json,
    html: markup, xml: markup, svg: markup, vue: markup, svelte: markup, htm: markup, xhtml: markup,
    css: css, scss: css, sass: css, less: css,
    markdown: markdown, md: markdown, mdx: markdown,
    diff: diff, patch: diff,
  };

  function normalize(lang) {
    var key = String(lang || '').trim().toLowerCase();
    if (!key) { return null; }
    return ALIASES[key] || key;
  }

  function render(code, lang) {
    var key = normalize(lang);
    if (!key) { return esc(code); }
    if (DEDICATED[key]) { return DEDICATED[key](code); }
    var rules = LANGUAGES[key] || LANGUAGES.generic;
    return generic(code, rules);
  }

  // ---------------------------------------------------------------- 通用

  // 使用粘性（sticky）正则，在扫描位置上匹配，而不是对切片后的尾部匹配。
  // `code.slice(i)` 会为每个词法单元复制代码块的剩余部分，使高亮一段长代码在
  // 内存分配上退化为 O(n²)——填满新生代堆的正是这些副本。粘性正则读取同样的
  // 字符却不复制它们；扫描位置由 `lastIndex` 携带。
  var RE_VARIABLE = /\$[A-Za-z_]\w*|\$\{[^}]*\}|\$\([^)]*\)/y;
  var RE_NUMBER =
    /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)n?/y;
  var RE_WORD = /[@$\\]?[A-Za-z_][\w$]*/y;
  var RE_AFTER = /\s*(.)/y;

  var PUNCTUATION = '+-*/%=<>!&|^~?:;,.()[]{}';

  function isWordCode(c) {
    return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
           c === 95 || c === 36;
  }

  function isWordStart(c) {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 ||
           c === 64 || c === 92;
  }

  function generic(code, rules) {
    var classes = classMap(rules);
    var exact = classes.exact;
    var lower = classes.lower;
    var quotes = rules.quotes || '"\'';
    var out = '';
    var i = 0;
    var n = code.length;

    while (i < n) {
      var ch = code[i];
      var code0 = code.charCodeAt(i);

      if (rules.line && code0 === rules.line.charCodeAt(0) && code.startsWith(rules.line, i)) {
        var lineEnd = code.indexOf('\n', i);
        if (lineEnd < 0) { lineEnd = n; }
        out += span('comment', code.slice(i, lineEnd));
        i = lineEnd;
        continue;
      }

      if (rules.block && code0 === rules.block[0].charCodeAt(0) &&
          code.startsWith(rules.block[0], i)) {
        var close = code.indexOf(rules.block[1], i + rules.block[0].length);
        close = close < 0 ? n : close + rules.block[1].length;
        out += span('comment', code.slice(i, close));
        i = close;
        continue;
      }

      if (quotes.indexOf(ch) >= 0) {
        var triple = rules.triple && code.charCodeAt(i + 1) === code0 &&
                     code.charCodeAt(i + 2) === code0;
        var quote = triple ? ch + ch + ch : ch;
        var j = i + quote.length;
        while (j < n) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code.startsWith(quote, j)) { j += quote.length; break; }
          if (!triple && code[j] === '\n') { break; }
          j++;
        }
        out += span('string', code.slice(i, Math.min(j, n)));
        i = Math.min(j, n);
        continue;
      }

      if (rules.variables && ch === '$') {
        RE_VARIABLE.lastIndex = i;
        var varMatch = RE_VARIABLE.exec(code);
        if (varMatch) {
          out += span('variable', varMatch[0]);
          i += varMatch[0].length;
          continue;
        }
      }

      if (code0 >= 48 && code0 <= 57 && !isWordCode(code.charCodeAt(i - 1))) {
        RE_NUMBER.lastIndex = i;
        var numMatch = RE_NUMBER.exec(code);
        if (numMatch) {
          out += span('number', numMatch[0]);
          i += numMatch[0].length;
          continue;
        }
      }

      if (isWordStart(code0)) {
        RE_WORD.lastIndex = i;
        var wordMatch = RE_WORD.exec(code);
        // 单独一个反斜杠（或后面跟着非字母）能通过上面的判断，却不匹配标识符
        // 模式，因此这里可能匹配失败。没有这道防护，在代码块中输入 "\" 会在
        // 词法分析时抛错。
        if (!wordMatch) {
          out += esc(ch);
          i++;
          continue;
        }
        var word = wordMatch[0];
        var bare = word.replace(/^[@$\\]/, '');
        RE_AFTER.lastIndex = i + word.length;
        var after = RE_AFTER.exec(code);
        var nextChar = after ? after[1] : '';

        var kind = lower[bare.toLowerCase()] || exact[bare];
        if (kind === 'literal') {
          out += span('literal', word);
        } else if (kind === 'keyword') {
          out += span('keyword', word);
        } else if (kind === 'type') {
          out += span('type', word);
        } else if (kind === 'builtin') {
          out += span('builtin', word);
        } else if (nextChar === '(') {
          out += span('function', word);
        } else if (nextChar === ':') {
          out += span('property', word);
        } else if (bare.charCodeAt(0) >= 65 && bare.charCodeAt(0) <= 90 && bare.length > 1) {
          out += span('type', word);
        } else {
          out += esc(word);
        }
        i += word.length;
        continue;
      }

      if (PUNCTUATION.indexOf(ch) >= 0) {
        out += span('punct', ch);
        i++;
        continue;
      }

      out += esc(ch);
      i++;
    }

    return out;
  }

  // 过去，代码中的每个标识符都要依次在四个成员集合中查找——字面量、关键字、
  // 类型、内建对象——也就是每个词做四次字符串哈希，每个代码块重建四个对象。
  // 在构建期把它们合并成一张表，只剩两次查找（一次转小写、一次精确匹配）
  // 和每种语言一个缓存对象。
  //
  // 这些集合按优先级从弱到强写入，这样同时属于多类的词会保留旧查找顺序原先
  // 选中的那一类。
  var CLASS_CACHE = new WeakMap();

  function addWords(into, words, kind, lower) {
    if (!words) { return; }
    var list = String(words).split(/\s+/);
    for (var i = 0; i < list.length; i++) {
      var word = list[i];
      if (!word) { continue; }
      // 使用 null 原型，可以避免名为 "constructor" 的关键字命中原型链上的属性。
      into[lower ? word.toLowerCase() : word] = kind;
    }
  }

  function classMap(rules) {
    // 直接以规则对象本身作为键：`LANGUAGES` 中每种语言只有一个不可变对象，
    // 因此用对象标识作键既精确又零开销——若用规则文本构造缓存键，文档中每个
    // 代码块都要拼接几百个字符。
    var cached = CLASS_CACHE.get(rules);
    if (cached) { return cached; }

    // 旧的查找顺序是：字面量、关键字、类型、内建对象。
    var map = { exact: Object.create(null), lower: Object.create(null) };
    addWords(map.exact, rules.builtins, 'builtin');
    addWords(map.exact, rules.types, 'type');
    addWords(map.exact, rules.keywords, 'keyword');
    // 字面量是唯一一类不区分大小写匹配的词。
    addWords(map.lower, rules.literals, 'literal', true);

    CLASS_CACHE.set(rules, map);
    return map;
  }

  // -------------------------------------------------------------- 专用扫描

  function json(code) {
    var out = '';
    var pattern = /("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\],:])|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;
    var last = 0;
    var match;
    while ((match = pattern.exec(code))) {
      out += esc(code.slice(last, match.index));
      if (match[1]) {
        var tail = code.slice(match.index + match[0].length);
        out += /^\s*:/.test(tail) ? span('property', match[1]) : span('string', match[1]);
      } else if (match[2]) {
        out += span('number', match[2]);
      } else if (match[3]) {
        out += span('literal', match[3]);
      } else if (match[4]) {
        out += span('punct', match[4]);
      } else {
        out += span('comment', match[5]);
      }
      last = match.index + match[0].length;
    }
    return out + esc(code.slice(last));
  }

  function markup(code) {
    var out = '';
    var i = 0;
    var n = code.length;
    while (i < n) {
      if (code.startsWith('<!--', i)) {
        var commentEnd = code.indexOf('-->', i);
        commentEnd = commentEnd < 0 ? n : commentEnd + 3;
        out += span('comment', code.slice(i, commentEnd));
        i = commentEnd;
        continue;
      }
      if (code.startsWith('<!', i) || code.startsWith('<?', i)) {
        var declEnd = code.indexOf('>', i);
        declEnd = declEnd < 0 ? n : declEnd + 1;
        out += span('meta', code.slice(i, declEnd));
        i = declEnd;
        continue;
      }
      if (code[i] === '<') {
        var tagMatch = /^<\/?([a-zA-Z][\w:.-]*)/.exec(code.slice(i));
        if (tagMatch) {
          var closing = code[i + 1] === '/';
          out += span('punct', closing ? '</' : '<');
          i += closing ? 2 : 1;
          out += span('tag', tagMatch[1]);
          i += tagMatch[1].length;
          while (i < n && code[i] !== '>') {
            if (code[i] === '/') { out += span('punct', '/'); i++; continue; }
            if (/\s/.test(code[i])) { out += code[i]; i++; continue; }
            var attrMatch = /^[^\s=>/]+/.exec(code.slice(i));
            if (!attrMatch) { out += esc(code[i]); i++; continue; }
            out += span('attr', attrMatch[0]);
            i += attrMatch[0].length;
            var gap = /^\s*/.exec(code.slice(i))[0];
            out += gap;
            i += gap.length;
            if (code[i] === '=') {
              out += span('punct', '=');
              i++;
              var pad = /^\s*/.exec(code.slice(i))[0];
              out += pad;
              i += pad.length;
              var valueMatch = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s>]+)/.exec(code.slice(i));
              if (valueMatch) {
                out += span('string', valueMatch[0]);
                i += valueMatch[0].length;
              }
            }
          }
          if (code[i] === '>') { out += span('punct', '>'); i++; }
          continue;
        }
      }
      var textMatch = /^[^<]+/.exec(code.slice(i));
      if (textMatch) { out += esc(textMatch[0]); i += textMatch[0].length; continue; }
      out += esc(code[i]);
      i++;
    }
    return out;
  }

  function css(code) {
    var out = '';
    var pattern = /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(@[\w-]+)|(#[0-9a-fA-F]{3,8}\b)|(-?(?:\d*\.)?\d+(?:[a-z%]{0,4})?)|([{}();:,])|(--[\w-]+)|([\w-]+)/g;
    var last = 0;
    var match;
    var inBlock = false;
    while ((match = pattern.exec(code))) {
      out += esc(code.slice(last, match.index));
      last = match.index + match[0].length;
      if (match[1]) {
        out += span('comment', match[1]);
      } else if (match[2]) {
        out += span('string', match[2]);
      } else if (match[3]) {
        out += span('keyword', match[3]);
      } else if (match[4]) {
        out += span('number', match[4]);
      } else if (match[5]) {
        out += span('number', match[5]);
      } else if (match[6]) {
        if (match[6] === '{') { inBlock = true; } else if (match[6] === '}') { inBlock = false; }
        out += span('punct', match[6]);
      } else if (match[7]) {
        out += span('variable', match[7]);
      } else if (match[8]) {
        var tail = code.slice(last).match(/^\s*:/);
        if (inBlock && tail) {
          out += span('property', match[8]);
        } else if (inBlock) {
          out += span('literal', match[8]);
        } else {
          out += span('tag', match[8]);
        }
      } else {
        out += esc(match[0]);
      }
    }
    return out + esc(code.slice(last));
  }

  function markdown(code) {
    return code.split('\n').map(function (line) {
      var heading = /^(#{1,6})(\s+)(.*)$/.exec(line);
      if (heading) {
        return span('keyword', heading[1]) + heading[2] + span('tag', heading[3]);
      }
      var quote = /^(\s*>+\s?)(.*)$/.exec(line);
      if (quote) {
        return span('comment', quote[1]) + span('string', quote[2]);
      }
      var list = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(line);
      if (list) {
        return span('variable', list[1]) + inlineMd(list[2]);
      }
      return inlineMd(line);
    }).join('\n');
  }

  function inlineMd(line) {
    var out = '';
    var last = 0;
    var pattern = /(`[^`]*`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)|(\[[^\]]*\]\([^)]*\))/g;
    var match;
    while ((match = pattern.exec(line))) {
      out += esc(line.slice(last, match.index));
      if (match[1]) { out += span('string', match[1]); }
      else if (match[2]) { out += span('builtin', match[2]); }
      else { out += span('type', match[0]); }
      last = match.index + match[0].length;
    }
    return out + esc(line.slice(last));
  }

  function diff(code) {
    return code.split('\n').map(function (line) {
      if (/^(\+\+\+|---)/.test(line)) { return span('meta', line); }
      if (/^@@/.test(line)) { return span('keyword', line); }
      if (/^\+/.test(line)) { return span('inserted', line); }
      if (/^-/.test(line)) { return span('deleted', line); }
      return esc(line);
    }).join('\n');
  }

  global.Highlight = {
    render: render,
    normalize: normalize,
  };
})(window);
