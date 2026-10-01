/*!
 * cNote Markdown 引擎
 * 无第三方依赖的 CommonMark/GFM 子集渲染器：标题、强调、删除线、高亮、任务
 * 列表、表格、脚注、围栏代码、行内/块级公式、引用式链接、YAML 前言信息、
 * [TOC]、定义列表、上标/下标、emoji 短代码以及图片对齐。
 */
(function (global) {
  'use strict';

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(value) {
    // 替换函数被提升到外层：在逐行渲染 1.5 MB 文档时，
    // 每次转义都分配一个闭包的开销会明显体现出来。
    return String(value).replace(ESCAPE_PATTERN, escapeReplacer);
  }

  var ESCAPE_PATTERN = /[&<>"']/g;
  function escapeReplacer(c) { return ESCAPES[c]; }

  function slugify(text, used) {
    // 一次字符判断走完，取代过去流水线式的六个正则表达式：那时的每一步都要
    // 再遍历一遍字符串，而且每次调用都有正则进入开销——在标题数以千计的文档上
    // 光是这一项就相当可观。
    //
    // 保留的字符与旧模式允许通过的相同：ASCII 单词字符、CJK 与假名区段，
    // 以及 `-`。其余字符一律丢弃，只是词与词之间的连续分隔符会合并成一个 `-`。
    var source = String(text).toLowerCase();
    var out = '';
    var gap = false;      // 有分隔符待处理，但仅在已经出现词之后才生效
    var inTag = false;    // 处于 <...> 内部，整体丢弃

    for (var i = 0; i < source.length; i++) {
      var ch = source.charCodeAt(i);
      if (inTag) {
        if (ch === 62) { inTag = false; }
        continue;
      }
      if (ch === 60) { inTag = true; continue; }
      if (ch === 45 || ch === 32 || ch === 9 || ch === 10 || ch === 13) {
        if (out) { gap = true; }
        continue;
      }
      var keep = (ch >= 48 && ch <= 57) || (ch >= 97 && ch <= 122) || ch === 95 ||
                 (ch >= 0x3400 && ch <= 0x9FFF) || (ch >= 0x3040 && ch <= 0x30FF);
      if (!keep) { continue; }
      if (gap) { out += '-'; gap = false; }
      out += source[i];
    }

    var base = out || 'section';
    var id = base;
    var index = 1;
    // 用 Map 而不是普通对象：键是任意标题文本，用普通对象会让每次查找都把
    // 一个新字符串哈希进字典模式的对象里，标题数以千计的文档要为此付出代价。
    while (used.has(id)) { id = base + '-' + (++index); }
    used.set(id, true);
    return id;
  }

  function safeUrl(url, resolve) {
    var value = String(url == null ? '' : url).trim();
    var lower = value.toLowerCase().replace(/[\s\u0000-\u001f]/g, '');
    if (/^(javascript|vbscript|file):/.test(lower)) { return ''; }
    if (/^data:/.test(lower) && !/^data:image\//.test(lower)) { return ''; }
    return resolve ? resolve(value) : value;
  }

  // ------------------------------------------------------------------ 行内

  // 全局匹配并显式设置 `lastIndex`：扫描器直接指向原字符串中的某个位置并从那里
  // 寻找下一个特殊字符，而不是每次迭代都切出一段新的尾部字符串
  // （markdown-it 的行内解析器也是按位置遍历 `state.src` 的）。
  var SPECIALS = /[\\`*_~=\[!$<&\n^:]/g;

  // 这些词法单元模式都是粘性的，因此在原文本的扫描位置上匹配。旧版本对每个
  // 词法单元都执行一次 `text.slice(i)`，再对副本用 `^…` 匹配，等于段落中每个
  // 词法单元都把段落剩余部分复制一遍——段落长度上呈平方级，也给回收器制造了
  // 每个词法单元一个新字符串。
  var RE_ESC = /\\([\\`*_{}\[\]()#+\-.!>~$|@])/y;
  var RE_BREAK = /(?: {2,}|\\)\n/y;
  var RE_CODESPAN = /(`+)([\s\S]*?)\1(?!`)/y;
  var RE_IMAGE = /!\[([^\]]*)\]\(\s*<?([^\s>)]*)>?(?:\s+["'(]([\s\S]*?)["')])?\s*\)(\{[^}\n]*\})?/y;
  var RE_LINK = /\[([^\]]*)\]\(\s*<?([^\s>)]*)>?(?:\s+["'(]([\s\S]*?)["')])?\s*\)/y;
  var RE_REFLINK = /\[([^\]]+)\]\[([^\]]*)\]/y;
  var RE_FNREF = /\[\^([^\]]+)\]/y;
  var RE_MATH2 = /\$\$([^$]+?)\$\$/y;
  var RE_MATH1 = /\$([^\s$][^$\n]*?)\$/y;
  var RE_URLINK = /<([a-z][a-z0-9+.-]{1,31}:\/\/[^ >]+)>/iy;
  var RE_MAILLINK = /<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/y;
  var RE_RAWTAG = /<\/?[a-zA-Z][^>]*>/y;
  var RE_ENTITY = /&(#\d{2,7}|#x[0-9a-f]{2,6}|[a-z][a-z0-9]{1,31});/iy;
  var RE_BAREURL = /https?:\/\/[^\s<>"'`]+/y;
  var RE_STRONGEM = /(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/y;
  var RE_STRONG = /(\*\*|__)(?=\S)([\s\S]*?\S)\1/y;
  var RE_EM = /(\*|_)(?=\S)([\s\S]*?\S)\1/y;
  var RE_DEL = /~~(?=\S)([\s\S]*?\S)~~/y;
  var RE_MARK = /==(?=\S)([\s\S]*?\S)==/y;
  var RE_SUP = /\^(\S(?:[^\s^]*\S)?)\^/y;
  var RE_SUB = /~(?!~)(\S(?:[^\s~]*\S)?)~(?!~)/y;

  /** 在 `text` 的 `at` 位置执行一个粘性模式。 */
  function matchAt(regex, text, at) {
    regex.lastIndex = at;
    return regex.exec(text);
  }

  // ------------------------------------------------------------- emoji 名称
  // 刻意做得很短：只收录笔记中最常见的那些，并且内联在代码里，
  // 这样应用仍然只发布一个文件，不需要额外加载查找表。
  var EMOJI = {
    smile: '\u{1F604}', grin: '\u{1F601}', joy: '\u{1F602}', wink: '\u{1F609}',
    heart: '\u2764\uFE0F', broken_heart: '\u{1F494}', thumbsup: '\u{1F44D}', '+1': '\u{1F44D}',
    thumbsdown: '\u{1F44E}', '-1': '\u{1F44E}', ok_hand: '\u{1F44C}', clap: '\u{1F44F}',
    pray: '\u{1F64F}', muscle: '\u{1F4AA}', wave: '\u{1F44B}', eyes: '\u{1F440}',
    fire: '\u{1F525}', star: '\u2B50', sparkles: '\u2728', zap: '\u26A1',
    rocket: '\u{1F680}', tada: '\u{1F389}', bug: '\u{1F41B}', wrench: '\u{1F527}',
    hammer: '\u{1F528}', gear: '\u2699\uFE0F', lock: '\u{1F512}', key: '\u{1F511}',
    bulb: '\u{1F4A1}', memo: '\u{1F4DD}', pencil: '\u270F\uFE0F', book: '\u{1F4D6}',
    books: '\u{1F4DA}', pushpin: '\u{1F4CC}', paperclip: '\u{1F4CE}', link: '\u{1F517}',
    package: '\u{1F4E6}', inbox_tray: '\u{1F4E5}', outbox_tray: '\u{1F4E4}', email: '\u{1F4E7}',
    computer: '\u{1F4BB}', iphone: '\u{1F4F1}', keyboard: '\u2328\uFE0F', floppy_disk: '\u{1F4BE}',
    cd: '\u{1F4BF}', hourglass: '\u231B', alarm_clock: '\u23F0', stopwatch: '\u23F1\uFE0F',
    calendar: '\u{1F4C5}', chart_with_upwards_trend: '\u{1F4C8}', chart_with_downwards_trend: '\u{1F4C9}',
    bar_chart: '\u{1F4CA}', clipboard: '\u{1F4CB}', folder: '\u{1F4C1}', file_folder: '\u{1F4C1}',
    open_file_folder: '\u{1F4C2}', page_facing_up: '\u{1F4C4}', page_with_curl: '\u{1F4C3}',
    magnifying_glass_tilted_left: '\u{1F50D}', mag: '\u{1F50D}', bell: '\u{1F514}', no_bell: '\u{1F515}',
    speech_balloon: '\u{1F4AC}', thought_balloon: '\u{1F4AD}', warning: '\u26A0\uFE0F',
    exclamation: '\u2757', question: '\u2753', information_source: '\u2139\uFE0F',
    white_check_mark: '\u2705', heavy_check_mark: '\u2714\uFE0F', x: '\u274C',
    no_entry: '\u26D4', recycle: '\u267B\uFE0F', eyes_shield: '\u{1F9D1}',
    coffee: '\u2615', beer: '\u{1F37B}', pizza: '\u{1F355}', cake: '\u{1F370}',
    apple: '\u{1F34E}', banana: '\u{1F34C}', sun: '\u2600\uFE0F', moon: '\u{1F319}',
    cloud: '\u2601\uFE0F', rain: '\u{1F327}\uFE0F', snowflake: '\u2744\uFE0F', rainbow: '\u{1F308}',
    earth_asia: '\u{1F30F}', globe_with_meridians: '\u{1F310}', cat: '\u{1F431}', dog: '\u{1F436}',
    panda_face: '\u{1F43C}', penguin: '\u{1F427}', bird: '\u{1F426}', fish: '\u{1F41F}',
    crown: '\u{1F451}', gem: '\u{1F48E}', moneybag: '\u{1F4B0}', gift: '\u{1F381}',
    '100': '\u{1F4AF}', checkered_flag: '\u{1F3C1}', trophy: '\u{1F3C6}', medal_sports: '\u{1F3C5}',
    point_right: '\u{1F449}', point_left: '\u{1F448}', point_up: '\u261D\uFE0F', point_down: '\u{1F447}',
    raised_hand: '\u270B', v: '\u270C\uFE0F', handshake: '\u{1F91D}', raised_hands: '\u{1F64C}',
    boom: '\u{1F4A5}', dizzy: '\u{1F4AB}', pig: '\u{1F437}', unicorn: '\u{1F984}',
    ghost: '\u{1F47B}', alien: '\u{1F47D}', robot: '\u{1F916}', skull: '\u{1F480}',
    pensive: '\u{1F614}', thinking: '\u{1F914}', sweat_smile: '\u{1F605}', cry: '\u{1F622}',
    sob: '\u{1F62D}', angry: '\u{1F620}', sunglasses: '\u{1F60E}', heart_eyes: '\u{1F60D}',
    cool: '\u{1F60E}', ok: '\u{1F44C}', ticket: '\u{1F3AB}', label: '\u{1F3F7}\uFE0F',
    bookmark: '\u{1F516}', triangular_flag_on_post: '\u{1F6A9}', sailboat: '\u26F5',
    airplane: '\u2708\uFE0F', car: '\u{1F697}', bike: '\u{1F6B2}', bus: '\u{1F68C}',
    train: '\u{1F686}', house: '\u{1F3E0}', office: '\u{1F3E2}', hospital: '\u{1F3E5}',
    wave_dash: '\u301C', globe: '\u{1F30F}', hot_beverage: '\u2615', balloon: '\u{1F388}',
  };

  var RE_EMOJI = /:([a-z0-9_+\-]{1,40}):/y;

  function inline(text, ctx) {
    // 只提取标题的遍历会走同一套块结构，但把渲染出的 HTML 丢弃；跳过行内处理
    // 正是它足够廉价、可以按自己的节奏为大纲单独运行的原因。
    if (ctx.headingsOnly) { return ''; }

    // 实测：把这些内容收集进数组最后再 join，比用 `+=` 慢约 20%。V8 的 rope
    // 结构让字符串拼接的均摊复杂度是 O(1)，而数组无论如何都要为扩容和最后
    // 一次展平付出代价。
    var out = '';
    var i = 0;
    var length = text.length;

    while (i < length) {
      SPECIALS.lastIndex = i;
      var found = SPECIALS.exec(text);
      var at = found ? found.index : length;
      if (at > i) {
        out += esc(text.slice(i, at));
        i = at;
        if (i >= length) { break; }
      }

      var match;

      // 反斜杠转义
      if ((match = matchAt(RE_ESC, text, i))) {
        out += esc(match[1]);
        i += match[0].length;
        continue;
      }

      // 强制换行
      if ((match = matchAt(RE_BREAK, text, i))) {
        out += '<br>';
        i += match[0].length;
        continue;
      }

      // 段落内部的单个换行。CommonMark 会把它折叠成空格，但本编辑器是源码与
      // 渲染结果并排显示，因此改用 GFM 的 `breaks` 行为：作者在哪里换行，
      // 读者就在哪里换行。这也正是两个窗格能够逐行对齐的原因，
      // 段落自身的行数也因此与它占用的行数一致。
      if (ctx.breaks && text.charCodeAt(i) === 10) {
        out += '<br>';
        i += 1;
        continue;
      }

      // 行内代码
      if ((match = matchAt(RE_CODESPAN, text, i))) {
        var code = match[2].replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && code.trim()) { code = code.slice(1, -1); }
        out += '<code class="md-code">' + esc(code) + '</code>';
        i += match[0].length;
        continue;
      }

      // 图片，可附带 {align=center width=480} 形式的属性块
      if ((match = matchAt(RE_IMAGE, text, i))) {
        var src = safeUrl(match[2], ctx.resolveUrl);
        var alt = match[1];
        if (src) {
          var image = '<img src="' + esc(src) + '" alt="' + esc(alt) + '"' +
            (match[3] ? ' title="' + esc(match[3]) + '"' : '') +
            (imageWidth(match[4]) ? ' width="' + imageWidth(match[4]) + '"' : '') +
            ' loading="lazy">';
          var align = imageAlign(match[4]);
          out += align ? '<figure class="md-figure is-' + align + '">' + image + '</figure>' : image;
        } else {
          out += esc(match[0]);
        }
        i += match[0].length;
        continue;
      }

      // 行内链接
      if ((match = matchAt(RE_LINK, text, i))) {
        out += renderLink(match[1], match[2], match[3], ctx);
        i += match[0].length;
        continue;
      }

      // 引用式链接 [text][ref] 或 [ref][]
      if ((match = matchAt(RE_REFLINK, text, i))) {
        var ref = (match[2] || match[1]).toLowerCase();
        if (ctx.defs[ref]) {
          out += renderLink(match[1], ctx.defs[ref].url, ctx.defs[ref].title, ctx);
          i += match[0].length;
          continue;
        }
      }

      // 脚注引用
      if ((match = matchAt(RE_FNREF, text, i))) {
        var note = ctx.notes[match[1].toLowerCase()];
        if (note) {
          out += '<sup class="md-fn-ref"><a id="fnref-' + esc(note.id) + '" href="#fn-' + esc(note.id) +
            '" data-fn="' + esc(note.id) + '">[' + note.index + ']</a></sup>';
          i += match[0].length;
          continue;
        }
      }

      // 数学公式
      if (text.charCodeAt(i) === 36 && (match = matchAt(RE_MATH2, text, i))) {
        out += ctx.math(match[1].trim(), true);
        i += match[0].length;
        continue;
      }
      if (text.charCodeAt(i) === 36 && (match = matchAt(RE_MATH1, text, i)) &&
          !/^\d/.test(match[1])) {
        out += ctx.math(match[1], false);
        i += match[0].length;
        continue;
      }

      // 自动链接 <http://...> / <mail@host>
      if (text.charCodeAt(i) === 60 && (match = matchAt(RE_URLINK, text, i))) {
        out += '<a href="' + esc(safeUrl(match[1], ctx.resolveUrl)) + '" target="_blank" rel="noreferrer">' +
          esc(match[1]) + '</a>';
        i += match[0].length;
        continue;
      }
      if (text.charCodeAt(i) === 60 && (match = matchAt(RE_MAILLINK, text, i))) {
        out += '<a href="mailto:' + esc(match[1]) + '">' + esc(match[1]) + '</a>';
        i += match[0].length;
        continue;
      }

      // 原始行内 HTML
      if (text.charCodeAt(i) === 60 && (match = matchAt(RE_RAWTAG, text, i))) {
        out += match[0];
        i += match[0].length;
        continue;
      }

      // 实体保持作者书写的形式
      if (text.charCodeAt(i) === 38 && (match = matchAt(RE_ENTITY, text, i))) {
        out += match[0];
        i += match[0].length;
        continue;
      }

      // 裸 URL
      if ((match = matchAt(RE_BAREURL, text, i))) {
        var trimmed = match[1].replace(/[.,;:!?)\]]+$/, '');
        out += '<a href="' + esc(safeUrl(trimmed, ctx.resolveUrl)) + '" target="_blank" rel="noreferrer">' +
          esc(trimmed) + '</a>';
        i += trimmed.length;
        continue;
      }

      // 强调系列
      if ((match = matchAt(RE_STRONGEM, text, i))) {
        out += '<strong><em>' + inline(match[2], ctx) + '</em></strong>';
        i += match[0].length;
        continue;
      }
      if ((match = matchAt(RE_STRONG, text, i))) {
        out += '<strong>' + inline(match[2], ctx) + '</strong>';
        i += match[0].length;
        continue;
      }
      if ((match = matchAt(RE_EM, text, i)) &&
          (match[1] === '*' || !isWordChar(text[i - 1]))) {
        out += '<em>' + inline(match[2], ctx) + '</em>';
        i += match[0].length;
        continue;
      }
      if ((match = matchAt(RE_DEL, text, i))) {
        out += '<del>' + inline(match[1], ctx) + '</del>';
        i += match[0].length;
        continue;
      }
      if ((match = matchAt(RE_MARK, text, i))) {
        out += '<mark>' + inline(match[1], ctx) + '</mark>';
        i += match[0].length;
        continue;
      }

      // 上标 / 下标：x^2^ 与 H~2~O。前瞻断言避免了把删除线形式
      // （~~text~~）误读成两个下标。
      if ((match = matchAt(RE_SUP, text, i))) {
        out += '<sup>' + inline(match[1], ctx) + '</sup>';
        i += match[0].length;
        continue;
      }
      if ((match = matchAt(RE_SUB, text, i))) {
        out += '<sub>' + inline(match[1], ctx) + '</sub>';
        i += match[0].length;
        continue;
      }

      // emoji 短代码
      if (text.charCodeAt(i) === 58 && (match = matchAt(RE_EMOJI, text, i))) {
        var emoji = EMOJI[match[1].toLowerCase()];
        if (emoji) {
          out += '<span class="md-emoji">' + emoji + '</span>';
          i += match[0].length;
          continue;
        }
      }

      out += esc(text[i]);
      i += 1;
    }

    return out;
  }

  /** 读取图片后面的 `{align=center width=480}` / `{center}`。 */
  function parseImageAttrs(text) {
    var attrs = { align: '', width: '' };
    if (!text) { return attrs; }
    String(text).replace(/^\{|\}$/g, '').split(/[\s,]+/).forEach(function (part) {
      if (!part) { return; }
      var pair = part.split('=');
      var key = pair[0].toLowerCase();
      var value = (pair[1] || '').toLowerCase().replace(/px$/, '');
      if (key === 'align' || key === 'a') {
        if (/^(left|center|right)$/.test(value)) { attrs.align = value; }
      } else if (/^(left|center|right)$/.test(key)) {
        attrs.align = key;
      } else if (key === 'width' || key === 'w') {
        if (/^\d{2,4}$/.test(value)) { attrs.width = value; }
      }
    });
    return attrs;
  }

  function imageAlign(text) { return parseImageAttrs(text).align; }
  function imageWidth(text) { return parseImageAttrs(text).width; }

  function isWordChar(ch) {
    return ch != null && /[\w\u3400-\u9fff]/.test(ch);
  }

  function renderLink(text, url, title, ctx) {
    var href = safeUrl(url, ctx.resolveUrl);
    var external = /^https?:/i.test(href);
    if (!href) { return esc(text); }
    return '<a href="' + esc(href) + '"' +
      (title ? ' title="' + esc(title) + '"' : '') +
      (external ? ' target="_blank" rel="noreferrer"' : '') +
      '>' + inline(text, ctx) + '</a>';
  }

  // ------------------------------------------------------------------- 块级

  var RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*?)(?:[ \t]+#+[ \t]*)?$/;
  var RE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/;
  var RE_HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
  var RE_QUOTE = /^ {0,3}>[ \t]?/;
  var RE_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
  var RE_DEF = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+["'(](.*)["')])?[ \t]*$/;
  var RE_FOOTDEF = /^ {0,3}\[\^([^\]]+)\]:[ \t]*(.*)$/;
  var RE_HTML_BLOCK = /^ {0,3}<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/;
  var RE_DEFLIST = /^ {0,3}:[ \t]+/;
  var RE_TOC = /^ {0,3}\[toc\][ \t]*$/i;
  var RE_FRONT_DELIM = /^(---|\.\.\.)[ \t]*$/;

  var HTML_BLOCK_TAGS = {
    address: 1, article: 1, aside: 1, blockquote: 1, details: 1, dialog: 1, div: 1, dl: 1,
    dd: 1, dt: 1, fieldset: 1, figcaption: 1, figure: 1, footer: 1, form: 1, h1: 1, h2: 1,
    h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hr: 1, main: 1, nav: 1, ol: 1, p: 1, pre: 1,
    section: 1, table: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, tr: 1, ul: 1,
    video: 1, audio: 1, iframe: 1, script: 1, style: 1, canvas: 1, svg: 1,
  };

  function render(source, options) {
    options = options || {};

    var ctx = {
      used: new Map(),
      headings: [],
      defs: {},
      notes: {},
      noteOrder: [],
      hasToc: false,
      // 默认关闭，使渲染器保持 CommonMark 行为；由应用负责开启。
      breaks: options.breaks === true,
      resolveUrl: options.resolveUrl || null,
      highlight: options.highlight || function (code) { return esc(code); },
      math: options.math || function (tex) { return '<code class="md-math-raw">' + esc(tex) + '</code>'; },
    };

    // 只需要块结构就能知道哪些行含有标题。否则代码块和块级公式还要承担一次
    // 完整的高亮或 MathML 渲染，而结果根本没人保留。
    if (options.headingsOnly) {
      ctx.headingsOnly = true;
      ctx.highlight = function () { return ''; };
      ctx.math = function () { return ''; };
    }

    var lines = toLines(source);
    var frontMatter = extractFrontMatter(lines, ctx);
    collectFootnotes(lines, ctx);

    var parsed = parseBlocks(lines, ctx, options);
    var blocks = options.blocks ? parsed.blocks : null;
    var html = '';

    if (blocks) {
      // `[TOC]` 只有见到所有标题之后才能展开，因此在解析完成后按块处理，
      // 而不是在解析过程中处理。
      for (var b = 0; b < blocks.length; b++) {
        blocks[b].html = fillToc(blocks[b].html, ctx);
        html += blocks[b].html;
      }
    } else {
      html = fillToc(parsed, ctx);
    }

    if (ctx.noteOrder.length) {
      var footnotes = '<section class="md-footnotes">\n<hr>\n<ol>\n';
      ctx.noteOrder.forEach(function (key) {
        var note = ctx.notes[key];
        footnotes += '<li id="fn-' + esc(note.id) + '">' + block(note.lines.join('\n'), ctx, { loose: true }) +
          ' <a class="md-fn-back" href="#fnref-' + esc(note.id) + '" data-fnback="' + esc(note.id) + '">↩</a></li>\n';
      });
      footnotes += '</ol>\n</section>\n';
      html += footnotes;
      if (blocks) { blocks.push({ html: footnotes, line: lines.length, endLine: lines.length }); }
    }

    var result = { html: frontMatter + html, headings: ctx.headings, frontMatter: ctx.frontMatter };
    if (blocks) {
      if (frontMatter) { blocks.unshift({ html: frontMatter, line: 0, endLine: 0 }); }
      result.blocks = blocks;
    }
    return result;
  }

  /**
   * YAML 前言信息会渲染成一张小的键值卡片。这些行仍留在数组中（清空内容），
   * 这样后面每个块都保持原有的行号，大纲正是靠它跳回编辑器中的对应位置。
   */
  function extractFrontMatter(lines, ctx) {
    ctx.frontMatter = null;
    if (lines.length < 3 || !/^---[ \t]*$/.test(lines[0])) { return ''; }

    var end = -1;
    for (var i = 1; i < lines.length; i++) {
      if (RE_FRONT_DELIM.test(lines[i])) { end = i; break; }
    }
    if (end < 1) { return ''; }

    var pairs = [];
    for (var j = 1; j < end; j++) {
      var match = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(lines[j]);
      if (match) {
        pairs.push({ key: match[1], value: match[2].trim() });
      } else if (pairs.length && /^\s+\S/.test(lines[j])) {
        pairs[pairs.length - 1].value += ' ' + lines[j].trim();
      }
    }
    if (!pairs.length) { return ''; }

    for (var k = 0; k <= end; k++) { lines[k] = ''; }
    ctx.frontMatter = pairs;

    return '<div class="md-frontmatter">\n' + pairs.map(function (pair) {
      return '<div class="md-fm-row"><span class="md-fm-key">' + esc(pair.key) +
        '</span><span class="md-fm-value">' + inline(pair.value, ctx) + '</span></div>';
    }).join('\n') + '\n</div>\n';
  }

  /** 把 `[TOC]` 行留下的占位内容替换为嵌套列表。 */
  function fillToc(html, ctx) {
    // 用标志位而不是查找：解析过程本来就知道自己有没有输出占位内容，
    // 而在数 MB 的字符串里搜一次，比大文档渲染其余部分加起来还贵。
    if (!ctx.hasToc) { return html; }
    return html.split('<div class="md-toc-placeholder"></div>\n').join(buildToc(ctx.headings));
  }

  function buildToc(headings) {
    if (!headings || !headings.length) { return ''; }
    var base = headings.reduce(function (low, heading) {
      return Math.min(low, heading.level);
    }, 6);

    var html = '<nav class="md-toc">\n<div class="md-toc-title">目录</div>\n';
    var depth = 0;
    headings.forEach(function (heading) {
      var level = Math.max(1, heading.level - base + 1);
      if (level > depth) {
        while (depth < level) { html += '<ul>\n'; depth++; }
      } else {
        html += '</li>\n';
        while (depth > level) { html += '</ul>\n</li>\n'; depth--; }
      }
      html += '<li><a href="#' + esc(heading.id) + '">' + esc(heading.text) + '</a>';
    });
    while (depth > 0) { html += '</li>\n</ul>\n'; depth--; }
    return html + '</nav>\n';
  }

  function isBlank(line) {
    // 逐字符扫描而不是 `trim()`：文档每一行都要执行两次，而只要行首有空格，
    // trim 就会新分配一个字符串。
    if (!line) { return true; }
    for (var i = 0; i < line.length; i++) {
      var ch = line.charCodeAt(i);
      if (ch !== 32 && ch !== 9) { return false; }
    }
    return true;
  }

  /**
   * 把行首空白中的制表符展开到下一个 4 的倍数——这是 CommonMark 在空白决定块
   * 结构时使用的制表位。
   *
   * 第一个非空白字符之后的制表符属于内容，保持原样，因此 `\tfoo\tbar` 会变成
   * 四个空格、`foo`，再加一个字面制表符，与规范自带的示例一致。
   */
  function expandLeadingTabs(line) {
    var first = line.charCodeAt(0);
    if (first !== 32 && first !== 9) { return line; }

    var width = 0;
    var at = 0;
    var sawTab = false;
    for (; at < line.length; at++) {
      var ch = line.charCodeAt(at);
      if (ch === 32) { width++; }
      else if (ch === 9) { width += 4 - (width % 4); sawTab = true; }
      else { break; }
    }
    if (!sawTab) { return line; }

    var indent = '';
    while (indent.length < width) { indent += ' '; }
    return indent + line.slice(at);
  }

  /**
   * 把源文本切分成行，并展开行首的制表符。
   *
   * 下面每个块级判断都是按空格书写的（`^ {0,3}` 之类），因此在这里统一处理一次，
   * 用制表符缩进的文档才能和用等量空格缩进的文档解析结果一致。
   */
  function toLines(source) {
    var text = String(source == null ? '' : source);
    // 统一换行符要扫描整个文档，而进到这里的内容本来就已经按文本读取过，
    // 所以只有在确实存在回车符时才值得做。
    if (text.indexOf('\r') >= 0) { text = text.replace(/\r\n?/g, '\n'); }
    var lines = text.split('\n');
    // 制表符只在影响块结构的地方才有意义，而大多数文档里一个都没有——
    // 因此先用一次扫描做前置判断，而不是对文件的每一行都做字符检查。
    if (text.indexOf('\t') < 0) { return lines; }
    for (var i = 0; i < lines.length; i++) { lines[i] = expandLeadingTabs(lines[i]); }
    return lines;
  }

  /** 制表符展开后，一行缩进的宽度（以空格计）。 */
  function leadingSpaces(line) {
    var at = 0;
    while (at < line.length && line.charCodeAt(at) === 32) { at++; }
    return at;
  }

  /**
   * 判断段落中的某一行是开启一个新块，还是继续当前段落。
   *
   * 在长文档中，普通正文占了绝大多数行，这一次比较就能让六个带锚点的模式不必
   * 在每一行上运行——这正是 markdown-it 采用的按首字符分派的做法。
   * 表格行可能在行内任意位置以 `|` 开头，因此该项判断单独处理。
   */
  function interruptsParagraph(line, next) {
    var lead = line.charCodeAt(0);
    if (lead === 32 || lead === 35 || lead === 36 || lead === 42 || lead === 43 ||
        lead === 45 || lead === 62 || lead === 91 || lead === 95 || lead === 96 ||
        lead === 126 || (lead >= 48 && lead <= 57)) {
      if (RE_ATX.test(line) || RE_FENCE.test(line) || RE_HR.test(line) ||
          RE_QUOTE.test(line) || interruptsWithListItem(line) || RE_FOOTDEF.test(line) ||
          /^ {0,3}\$\$/.test(line)) {
        return true;
      }
    }
    return line.indexOf('|') >= 0 && isTableSeparator(next || '');
  }

  /**
   * 判断某一行是否开启了一个可以打断段落的列表项。
   *
   * 无序列表总是可以。有序列表只有从 1 开始时才可以——“The number of doors is 6.”
   * 后面跟着 “14. The number of windows” 仍属于同一段落，因为从 14 开始的列表
   * 读起来更像是作者折行写下的句子，而不是一个新列表。
   */
  function interruptsWithListItem(line) {
    var match = RE_ITEM.exec(line);
    if (!match) { return false; }
    return !/^\d/.test(match[2]) || /^1[.)]$/.test(match[2]);
  }

  /**
   * 脚注通常写在笔记末尾，却在开头附近被引用，因此先统一收集定义，并把它们所在
   * 的行清空（保持其他所有行的行号不变）。
   */
  function collectFootnotes(lines, ctx) {
    for (var i = 0; i < lines.length; i++) {
      var match = RE_FOOTDEF.exec(lines[i]);
      if (!match) { continue; }

      var key = match[1].toLowerCase();
      var body = [match[2]];
      lines[i] = '';
      var j = i + 1;
      while (j < lines.length) {
        if (isBlank(lines[j])) {
          var ahead = lines[j + 1] == null ? '' : lines[j + 1];
          if (!/^ {2,}/.test(ahead)) { break; }
          body.push('');
          lines[j] = '';
          j++;
          continue;
        }
        if (/^ {2,}/.test(lines[j])) {
          body.push(lines[j].replace(/^ {0,4}/, ''));
          lines[j] = '';
          j++;
          continue;
        }
        break;
      }

      if (!ctx.notes[key]) {
        ctx.notes[key] = {
          // 一次性的集合：脚注锚点由收集器编号，
          // 不存在需要消歧的对象。
          id: slugify('fn-' + key, new Map()),
          index: ctx.noteOrder.length + 1,
          lines: body,
        };
        ctx.noteOrder.push(key);
      }
    }
  }

  /**
   * 自顶向下解析文档，一次处理一个顶层块。
   *
   * 传入 `options.blocks` 时，结果还会附带按这些块边界切分好的文档。需要它的是
   * 预览：一次按键只会改变一个块，那就只重建这一个块，
   * 而不必每次都重新解析并重新排版整个文档。
   */
  function parseBlocks(lines, ctx, options) {
    options = options || {};
    var base = lineOffset(options);
    var blocks = options.blocks ? [] : null;
    var out = '';
    var piece = '';
    var i = 0;

    // 每轮处理一个块。这条判断链取代了“每个构造一次测试”的循环所需的 `continue`
    // 语句，因此所有路径最后都汇到同一个地方：块边界，在这里把结果归档。
    while (i < lines.length) {
      var start = i;
      var line = lines[i];
      var match;

      // 下面每种构造都靠首个非空白字符识别，因此一次比较就能在运行任何模式之前
      // 排除掉大部分情况。普通正文——占绝大多数行——一次 `indexOf` 之后就走完了
      // 这条链。这正是 markdown-it 采用的分派方式，也是十万行的文档不必每行都跑
      // 十几个带锚点正则的原因。
      var at = 0;
      while (line.charCodeAt(at) === 32) { at++; }
      var lead = line.charCodeAt(at);

      if (isBlank(line)) {
        i++;
      } else if ((lead === 96 || lead === 126) && (match = RE_FENCE.exec(line))) {
        // 围栏代码块
        var fence = match[1];
        var info = (match[2] || '').trim();
        var body = [];
        i++;
        var closer = new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$');
        while (i < lines.length && !closer.test(lines[i])) { body.push(lines[i]); i++; }
        i++;
        piece = renderCodeBlock(body.join('\n'), info, ctx);
      } else if (lead === 35 && (match = RE_ATX.exec(line))) {
        // ATX 标题
        var level = match[1].length;
        var text = match[2].trim();
        var id = slugify(text, ctx.used);
        ctx.headings.push({ level: level, text: plainText(text), id: id, line: i + base });
        piece = '<h' + level + ' id="' + esc(id) + '">' + inline(text, ctx) + '</h' + level + '>\n';
        i++;
      } else if ((lead === 42 || lead === 45 || lead === 95) && RE_HR.test(line)) {
        // 分隔线
        piece = '<hr>\n';
        i++;
      } else if (lead === 91 && (match = RE_DEF.exec(line))) {
        // 引用定义：会被消费掉，但不产生任何绘制内容
        var key = match[1].toLowerCase();
        if (!ctx.defs[key]) { ctx.defs[key] = { url: match[2], title: match[3] || '' }; }
        i++;
      } else if (lead === 62 && RE_QUOTE.test(line)) {
        // 引用块
        var quoted = [];
        var quoteOffset = null;
        var quoteStart = i;
        while (i < lines.length && (RE_QUOTE.test(lines[i]) || (quoted.length && !isBlank(lines[i])))) {
          var raw = lines[i];
          if (RE_QUOTE.test(raw)) {
            var stripped = raw.replace(RE_QUOTE, '');
            if (quoteOffset == null) {
              var leading = /^( *)/.exec(stripped)[1].length;
              quoteOffset = leading;
            }
            quoted.push(stripped);
          } else {
            quoted.push(raw);
          }
          i++;
        }
        piece = '<blockquote>\n' +
          block(quoted.join('\n'), ctx, { loose: true, lineOffset: quoteStart + base }) +
          '</blockquote>\n';
      } else if (lead === 36 && /^ {0,3}\$\$/.test(line)) {
        // 块级公式
        var mathBody = [];
        var firstRest = line.replace(/^ {0,3}\$\$/, '');
        var closed = false;
        if (/\$\$\s*$/.test(firstRest) && firstRest.trim() !== '') {
          mathBody.push(firstRest.replace(/\$\$\s*$/, ''));
          i++;
          closed = true;
        } else {
          if (firstRest.trim()) { mathBody.push(firstRest); }
          i++;
          while (i < lines.length) {
            if (/\$\$\s*$/.test(lines[i])) {
              var tail = lines[i].replace(/\$\$\s*$/, '');
              if (tail.trim()) { mathBody.push(tail); }
              i++;
              closed = true;
              break;
            }
            mathBody.push(lines[i]);
            i++;
          }
        }
        if (closed) {
          piece = '<div class="md-math-block">' + ctx.math(mathBody.join('\n').trim(), true) + '</div>\n';
        } else {
          piece = '<p>' + inline('$$' + mathBody.join('\n'), ctx) + '</p>\n';
        }
      } else if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        // 表格
        var consumed = 0;
        piece = renderTable(lines, i, ctx, function (used) { consumed = used; });
        i += consumed;
      } else if (lead === 91 && RE_TOC.test(line)) {
        // [TOC] —— 等所有标题都收集完毕后才填充该列表。
        ctx.hasToc = true;
        piece = '<div class="md-toc-placeholder"></div>\n';
        i++;
      } else if (lead !== 58 && i + 1 < lines.length && RE_DEFLIST.test(lines[i + 1])) {
        // 定义列表：“术语”后跟一行或多行 “: 定义”
        var terms = '';
        while (i < lines.length && !isBlank(lines[i]) && !RE_DEFLIST.test(lines[i])) {
          terms += '<dt>' + inline(lines[i].trim(), ctx) + '</dt>\n';
          i++;
          while (i < lines.length && RE_DEFLIST.test(lines[i])) {
            terms += '<dd>' + inline(lines[i].replace(RE_DEFLIST, ''), ctx) + '</dd>\n';
            i++;
          }
        }
        piece = '<dl class="md-dl">\n' + terms + '</dl>\n';
      } else if ((lead === 42 || lead === 43 || lead === 45 || (lead >= 48 && lead <= 57)) &&
                 RE_ITEM.test(line)) {
        // 列表
        piece = renderList(lines, i, ctx, function (used) { i = used; }, base);
      } else if (lead === 60 && (match = RE_HTML_BLOCK.exec(line)) &&
                 HTML_BLOCK_TAGS[match[2].toLowerCase()]) {
        // HTML 块
        var htmlLines = [];
        while (i < lines.length && !isBlank(lines[i])) { htmlLines.push(lines[i]); i++; }
        piece = htmlLines.join('\n') + '\n';
      } else if (leadingSpaces(line) >= 4) {
        // 缩进代码块：缩进四个空格，制表符经 expandLeadingTabs 处理后也落在
        // 同样的位置。
        //
        // 块内的空行属于该块，但块末尾的空行属于后面的内容——因此扫描会回退到
        // 最后一个真正有内容的行。
        var codeLines = [];
        var codeEnd = i;
        while (i < lines.length) {
          var codeLine = lines[i];
          if (isBlank(codeLine)) { codeLines.push(''); i++; continue; }
          if (leadingSpaces(codeLine) < 4) { break; }
          codeLines.push(codeLine.slice(4));
          i++;
          codeEnd = i;
        }
        i = codeEnd;
        while (codeLines.length && codeLines[codeLines.length - 1] === '') { codeLines.pop(); }
        piece = renderCodeBlock(codeLines.join('\n'), '', ctx);
      } else {
        // 段落——最常见的情况，会一直延续到空行或只能开启新块的行。
        var para = [];
        while (i < lines.length && !isBlank(lines[i])) {
          var candidate = lines[i];
          if (para.length) {
            // 只能开启新块的结构会在这里结束当前段落。
            if (interruptsParagraph(candidate, lines[i + 1])) { break; }
            // setext 标题：段落文字下面用 === 或 --- 加下划线
            if (/^ {0,3}(=+|-+)[ \t]*$/.test(candidate)) {
              var text2 = para.join('\n').trim();
              var lvl = candidate.trim()[0] === '=' ? 1 : 2;
              var sid = slugify(text2, ctx.used);
              ctx.headings.push({ level: lvl, text: plainText(text2), id: sid, line: i + base });
              piece = '<h' + lvl + ' id="' + esc(sid) + '">' + inline(text2, ctx) + '</h' + lvl + '>\n';
              para = null;
              i++;
              break;
            }
          }
          para.push(candidate);
          i++;
        }
        if (para && para.length) {
          piece = '<p>' + inline(para.join('\n'), ctx) + '</p>\n';
        }
      }

      if (piece) {
        if (blocks) {
          blocks.push({ html: piece, line: start + base, endLine: i + base });
        } else {
          out += piece;
        }
        piece = '';
      }
    }

    if (!blocks) { return out; }
    var html = '';
    for (var b = 0; b < blocks.length; b++) { html += blocks[b].html; }
    return { html: html, blocks: blocks };
  }

  function block(source, ctx, options) {
    return parseBlocks(toLines(source), ctx, options);
  }

  /**
   * 嵌套块的首行在文档中的行号。
   *
   * 收集标题时会记录其所在行，以便大纲跳回对应位置，而引用块或列表项会把自己的
   * 行号从零重新编号。没有父级偏移量时，引用块里的 `##` 会被记成位于文件顶部，
   * 跳转也就跳到了那里。
   */
  function lineOffset(options) {
    return (options && options.lineOffset) || 0;
  }

  function plainText(text) {
    return String(text)
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~=]/g, '')
      .replace(/<[^>]*>/g, '')
      .trim();
  }

  function renderCodeBlock(code, info, ctx) {
    var lang = (info.split(/[\s:]/)[0] || '').toLowerCase();
    if (lang === 'math' || lang === 'latex' || lang === 'tex' || lang === 'katex') {
      return '<div class="md-math-block">' + ctx.math(code, true) + '</div>\n';
    }

    // 块扫描在拼接各行时不会在末尾加换行，但代码块的内容以换行结尾——
    // 规范给出的输出正是 `<pre><code>foo\n</code></pre>`。
    var highlighted = code ? ctx.highlight(code, lang) + '\n' : '';
    return '<div class="md-code-block" data-lang="' + esc(lang) + '">' +
      '<div class="md-code-head"><span class="md-code-lang">' + esc(lang || 'text') + '</span>' +
      '<button type="button" class="md-code-copy" title="复制代码">复制</button></div>' +
      '<pre><code class="hljs' + (lang ? ' language-' + esc(lang) : '') + '">' +
      highlighted + '</code></pre></div>\n';
  }

  function isTableSeparator(line) {
    return !!line && /^ *\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/.test(line) &&
      line.indexOf('-') >= 0;
  }

  function splitRow(row) {
    var text = row.trim();
    if (text.startsWith('|')) { text = text.slice(1); }
    if (text.endsWith('|') && !text.endsWith('\\|')) { text = text.slice(0, -1); }
    var cells = [];
    var current = '';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\\' && text[i + 1] === '|') { current += '|'; i++; continue; }
      if (ch === '|') { cells.push(current); current = ''; continue; }
      current += ch;
    }
    cells.push(current);
    return cells.map(function (cell) { return cell.trim(); });
  }

  /**
   * 从 `start` 处开始读取一个表格。
   *
   * 传入行数组加偏移量，而不是 `lines.slice(start)`：每次切片都会复制后面
   * 所有行，这让每个章节都带表格的文档在解析上呈平方级——2 MB 需要 0.6 秒，
   * 8 MB 则要 5.5 秒。
   */
  function renderTable(lines, start, ctx, done) {
    var header = splitRow(lines[start]);
    var aligns = splitRow(lines[start + 1]).map(function (cell) {
      var left = cell.startsWith(':');
      var right = cell.endsWith(':');
      if (left && right) { return 'center'; }
      if (right) { return 'right'; }
      if (left) { return 'left'; }
      return '';
    });

    var used = 2;
    var rows = [];
    while (start + used < lines.length && !isBlank(lines[start + used]) &&
           lines[start + used].indexOf('|') >= 0) {
      rows.push(splitRow(lines[start + used]));
      used++;
    }

    var out = '<div class="md-table-wrap"><table>\n<thead>\n<tr>';
    header.forEach(function (cell, index) {
      out += '<th' + alignClass(aligns[index]) + '>' + inline(cell, ctx) + '</th>';
    });
    out += '</tr>\n</thead>\n<tbody>\n';
    rows.forEach(function (row) {
      out += '<tr>';
      for (var c = 0; c < header.length; c++) {
        out += '<td' + alignClass(aligns[c]) + '>' + inline(row[c] == null ? '' : row[c], ctx) + '</td>';
      }
      out += '</tr>\n';
    });
    out += '</tbody>\n</table></div>\n';
    done(used);
    return out;
  }

  function alignClass(align) {
    return align ? ' class="md-al-' + align + '"' : '';
  }

  function renderList(lines, start, ctx, done, base) {
    base = base || 0;
    var first = RE_ITEM.exec(lines[start]);
    var baseIndent = first[1].length;
    var ordered = /\d/.test(first[2]);
    // 项目符号改变，或有序列表的分隔符改变，都会开始一个新列表；两种类型绝不
    // 混用。`- foo` 之后接 `+ bar` 是两个列表，而不是一个。
    var bullet = ordered ? first[2].slice(-1) : first[2];
    var startNumber = ordered ? parseInt(first[2], 10) : 1;
    var items = [];
    var i = start;
    var loose = false;

    while (i < lines.length) {
      var line = lines[i];

      if (isBlank(line)) {
        var lookahead = i + 1;
        while (lookahead < lines.length && isBlank(lines[lookahead])) { lookahead++; }
        if (lookahead >= lines.length) { break; }
        var nextMatch = RE_ITEM.exec(lines[lookahead]);
        var nextIndent = /^( *)/.exec(lines[lookahead])[1].length;
        if (nextMatch && nextMatch[1].length <= baseIndent) { loose = true; i = lookahead; continue; }
        if (nextIndent > baseIndent) { loose = true; i = lookahead; continue; }
        break;
      }

      var match = RE_ITEM.exec(line);
      if (match && match[1].length <= baseIndent + 1) {
        if (/\d/.test(match[2]) !== ordered) { break; }
        if (ordered ? match[2].slice(-1) !== bullet : match[2] !== bullet) { break; }
        items.push({ line: i, lines: [match[3] == null ? '' : match[3]] });
        i++;
        continue;
      }

      var indent = /^( *)/.exec(line)[1].length;
      if (items.length && indent > baseIndent) {
        var strip = Math.min(indent, baseIndent + 2);
        items[items.length - 1].lines.push(line.slice(strip));
        i++;
        continue;
      }

      break;
    }

    var out = ordered
      ? '<ol' + (startNumber !== 1 ? ' start="' + startNumber + '"' : '') + '>\n'
      : '<ul>\n';

    items.forEach(function (item) {
      var content = item.lines.join('\n');
      var task = /^\[([ xX])\][ \t]+/.exec(content);
      if (task) {
        var checked = task[1].toLowerCase() === 'x';
        content = content.slice(task[0].length);
        out += '<li class="md-task' + (checked ? ' is-done' : '') + '" data-line="' + (item.line || 0) + '">' +
          '<input type="checkbox" class="md-checkbox"' + (checked ? ' checked' : '') + '>' +
          '<div class="md-task-body">' +
            block(content, ctx, { loose: loose, lineOffset: item.line + base }) +
            '</div></li>\n';
        return;
      }

      if (loose) {
        out += '<li>' +
          block(content, ctx, { loose: true, lineOffset: item.line + base }) + '</li>\n';
      } else {
        var single = /^\s*$/.test(content) ? '' : inline(content.split('\n')[0], ctx);
        var extra = content.split('\n').slice(1).join('\n');
        // `extra` 从列表项所在行的下一行开始，因此它的首行是 item.line + 1
        // 而不是 item.line。
        out += '<li>' + single +
          (extra.trim() ? block(extra, ctx, { lineOffset: item.line + base + 1 }) : '') + '</li>\n';
      }
    });

    out += ordered ? '</ol>\n' : '</ul>\n';
    done(i);
    return out;
  }

  global.Markdown = {
    render: render,
    escape: esc,
    inline: inline,
    outline: buildToc,
    imageAttrs: parseImageAttrs,
    emoji: EMOJI,
  };
})(window);
