/*!
 * cNote —— 应用外壳。
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ 宿主桥接

  var sequence = 0;
  var pending = new Map();

  function hostCall(command, data) {
    return new Promise(function (resolve, reject) {
      var id = ++sequence;
      pending.set(id, { resolve: resolve, reject: reject });
      postToHost(JSON.stringify({ id: id, cmd: command, data: data || {} }), id, 1, reject);
    });
  }

  /**
   * 把一条请求交给宿主，桥接拒绝时重试一次。
   *
   * WebView2 控件短暂繁忙时 `postMessage` 会抛异常，而消息也就此丢失——一次没
   * 送达宿主的点击，就是一个毫无反应的按钮。每条命令都必须能安全地发送两次，
   * 因此会改变状态的命令携带目标状态，而不是做一次切换。
   */
  function postToHost(text, id, attempt, reject) {
    try {
      window.chrome.webview.postMessage(text);
    } catch (error) {
      if (attempt < 2) {
        setTimeout(function () { postToHost(text, id, attempt + 1, reject); }, 40);
        return;
      }
      pending.delete(id);
      reject(error);
    }
  }

  window.chrome.webview.addEventListener('message', function (event) {
    var message = event.data;
    if (!message) { return; }

    if (message.event === 'closeRequested') {
      requestClose();
      return;
    }

    // 可执行文件第二次启动时会把它的文件转到这里，而不是再开一个窗口。
    if (message.event === 'openPath') {
      if (message.path) { openPath(message.path); }
      return;
    }

    // 其他程序改写了（或删除了）某个已打开的笔记。
    if (message.event === 'fileChanged') {
      onExternalChange(message.path, !!message.removed);
      return;
    }

    var entry = pending.get(message.id);
    if (!entry) { return; }
    pending.delete(message.id);

    if (message.ok) {
      entry.resolve(message.data);
    } else {
      entry.reject(new Error(message.error || '操作失败'));
    }
  });

  // ------------------------------------------------------------------ 状态

  var EDIT_MODES = ['edit', 'split', 'read'];
  var MODE_LABEL = { edit: '源码', split: '分栏', read: '阅读' };

  var THEMES = [
    { id: 'paper', name: '纸白', swatch: ['#fdfcf9', '#efece5', '#b07d2b'], chrome: '#f7f5f0' },
    { id: 'github', name: '简洁', swatch: ['#ffffff', '#f0f1f3', '#2f6feb'], chrome: '#f4f6f8' },
    { id: 'solar', name: '青竹', swatch: ['#fdfcf5', '#eef1e8', '#1f8a70'], chrome: '#f2f4ee' },
    { id: 'sepia', name: '羊皮纸', swatch: ['#faf4e8', '#e7dcc6', '#a4622f'], chrome: '#ece3cf' },
    { id: 'night', name: '夜幕', swatch: ['#1c1e24', '#191a1f', '#6ea8fe'], chrome: '#1b1c20' },
    { id: 'ink', name: '墨黑', swatch: ['#151515', '#121212', '#d8a657'], chrome: '#131313' },
    { id: 'nord', name: '北境', swatch: ['#2e3440', '#2b303b', '#88c0d0'], chrome: '#2b303b' },
    { id: 'mocha', name: '摩卡', swatch: ['#222234', '#1e1e2e', '#cba6f7'], chrome: '#1f1f2e' },
  ];

  var SHORTCUTS = [
    ['新建文件', 'Ctrl+N'], ['打开文件', 'Ctrl+O'], ['保存', 'Ctrl+S'], ['另存为', 'Ctrl+Shift+S'],
    ['关闭标签', 'Ctrl+W'], ['切换标签', 'Ctrl+Tab'], ['查找 / 替换', 'Ctrl+F'], ['导出 HTML', 'Ctrl+Shift+E'],
    ['加粗', 'Ctrl+B'], ['斜体', 'Ctrl+I'], ['删除线', 'Ctrl+D'], ['高亮标记', 'Ctrl+E'],
    ['行内代码', 'Ctrl+`'], ['代码块', 'Ctrl+Shift+C'], ['插入链接', 'Ctrl+K'], ['插入图片', 'Ctrl+Shift+I'],
    ['插入公式', 'Ctrl+Shift+M'], ['插入表格', 'Ctrl+Alt+T'], ['脚注定义', 'Ctrl+Shift+F'],
    ['一级标题', 'Ctrl+Alt+1'], ['二级标题', 'Ctrl+Alt+2'], ['三级标题', 'Ctrl+Alt+3'],
    ['无序列表', 'Ctrl+Alt+U'], ['有序列表', 'Ctrl+Alt+O'], ['任务列表', 'Ctrl+Alt+X'], ['引用', 'Ctrl+Alt+Q'],
    ['源码 / 分栏 / 阅读', 'Ctrl+1 Ctrl+2 Ctrl+3'], ['专注模式', 'F8'], ['打字机模式', 'F9'],
    ['切换侧边栏', 'Ctrl+\\'], ['放大', 'Ctrl+='], ['重置字号', 'Ctrl+0'], ['快捷键帮助', 'F1'],
    ['打印', 'Ctrl+P'], ['导出为 Word / 纯文本 / 长图', '导出菜单'],
    ['表格增删行列 / 对齐', '工具栏表格工具'], ['图片对齐', '工具栏图片菜单'],
  ];

  var state = {
    tabs: [],
    activeId: 0,
    nextId: 1,
    config: null,
    treeRoot: '',
    // 面板会显示用户添加的每一个文件夹，而不只是一个。treeRoot 保留为其中第一个，
    // 供少数只需要单个路径的地方使用。
    treeRoots: [],
    treeCollapsed: {},
    treeExpanded: {},
    find: { matches: [], index: -1, byLine: new Map() },
    closing: false,
    dataDir: '',
    watchedPaths: null,
    restoring: false,
  };

  // 因预览窗格不在屏幕上而跳过重绘时置位。
  var previewStale = false;

  // 图片加载是唯一依赖原生宿主映射的预览功能，
  // 因此保留一个用于排查问题的诊断开关。
  var diagnoseImages = false;

  // -------------------------------------------------------------- 工具函数

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    // 回车符刻意以字符引用的形式输出：HTML 解析器会把字面 CR（以及 CRLF）规范化
    // 成 LF，因此通过 innerHTML 渲染的 CRLF 文档返回时每行都多了一个换行。这会
    // 使编辑区不再与文档逐字对应，下一次按键就把被弄乱的文本写回了文件。
    // 字符引用在规范化之后才解析，因此能保留为真正的 CR。
    return String(value).replace(/[&<>"'\r]/g, function (c) {
      return {
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;',
      }[c];
    });
  }

  function basename(path) {
    var parts = String(path).split(/[\\/]/);
    return parts[parts.length - 1] || path;
  }

  function humanSize(bytes) {
    if (bytes < 1024) { return bytes + ' B'; }
    if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  var toastTimer = 0;
  function toast(message, isError) {
    var node = dom.toast;
    node.textContent = message;
    node.classList.toggle('is-error', !!isError);
    node.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('is-on'); }, 2200);
  }

  function activeTab() {
    for (var i = 0; i < state.tabs.length; i++) {
      if (state.tabs[i].id === state.activeId) { return state.tabs[i]; }
    }
    return null;
  }

  function countWords(text) {
    var cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    var words = (text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ')
      .match(/[A-Za-z0-9_'\u00c0-\u024f]+/g) || []).length;
    return { words: words, chars: text.length, cjk: cjk };
  }

  var dom = {};

  function cacheDom() {
    ['app', 'titlebar', 'tbDrag', 'btnSidebar', 'viewSwitch',
      'btnFind', 'btnTheme', 'btnExport', 'winMin', 'winMax', 'winClose', 'winMaxIcon',
      'activity', 'sidebar', 'fileTree', 'outline', 'tabs', 'toolbar', 'panes',
      'editorPane', 'editorScroll', 'editorPage', 'editor', 'splitter', 'previewPane',
      'previewScroll', 'preview', 'previewTop', 'previewBottom',
      'findbar', 'findInput', 'replaceInput', 'findCount',
      'findPrev', 'findNext', 'findReplace', 'findReplaceAll',
      'statusPath', 'statusEncoding', 'statusCursor', 'statusCount', 'statusZoom', 'statusMode',
      'themePopover', 'exportPopover', 'ctxmenu', 'helpModal', 'helpClose', 'shortcutGrid', 'toast',
      'dialog',
      'btnHelp', 'btnPickFolder', 'btnRefreshTree', 'setFontSize', 'setLineHeight', 'setContentWidth',
      'treeSearch', 'btnTopmost', 'tabAll', 'tabNew',
      'setFontFamily', 'setGutter', 'setTypewriter', 'setFocus', 'setAutoSave', 'themeGrid',
      'tablePopover', 'imagePopover', 'btnTableTools', 'btnImage',
      'valFontSize', 'valLineHeight', 'valContentWidth', 'dataDir'].forEach(function (id) {
        dom[id] = $(id);
      });

    installEditorSurface();
  }

  // -------------------------------------------------------- 应用内对话框
  //
  // 原生 confirm()/prompt() 会渲染成以内部虚拟主机为标题的浏览器对话框
  // （“cnote.localhost 显示”），而且只提供两个按钮，因此“不保存直接退出”这类
  // 破坏性选项无处安放。

  var dialogResolver = null;

  function showDialog(options) {
    return new Promise(function (resolve) {
      dialogResolver = resolve;

      $('dialogTitle').textContent = options.title || 'cNote';
      $('dialogMessage').textContent = options.message || '';

      var input = $('dialogInput');
      input.style.display = options.input ? 'block' : 'none';
      input.value = options.input ? (options.value || '') : '';

      var actions = $('dialogActions');
      actions.innerHTML = (options.buttons || []).map(function (button) {
        var kind = button.primary ? ' is-primary' : (button.danger ? ' is-danger' : '');
        return '<button data-value="' + esc(button.value) + '" class="' + kind.trim() + '">' +
          esc(button.label) + '</button>';
      }).join('');

      Array.prototype.forEach.call(actions.children, function (node) {
        node.addEventListener('click', function () { closeDialog(node.dataset.value); });
      });

      dom.dialog.classList.add('is-on');
      if (options.input) { input.focus(); input.select(); }
    });
  }

  function closeDialog(value) {
    dom.dialog.classList.remove('is-on');

    var input = $('dialogInput');
    var text = input.style.display !== 'none' ? input.value : '';

    var resolve = dialogResolver;
    dialogResolver = null;
    if (resolve) { resolve({ value: value, text: text }); }
  }

  /** 取消 / 不保存 / 保存，措辞随当前待处理的操作变化。 */
  function saveChoices(action) {
    return [
      { label: '取消', value: 'cancel' },
      { label: '不保存并' + action, value: 'discard', danger: true },
      { label: '保存并' + action, value: 'save', primary: true },
    ];
  }

  function saveTabForClose(tab) {
    if (!tab.path) {
      return hostCall('saveAs', { text: tab.text, suggested: tabTitle(tab) })
        .then(function (data) {
          if (!data || data.canceled) { return false; }
          tab.path = data.path;
          tab.name = data.name || basename(data.path);
          tab.savedText = tab.text;
          tab.dirty = false;
          if (tab === activeTab()) { syncDocDirectory(tab); }
          renderTabs();
          return true;
        })
        .catch(function (error) { toast(error.message, true); return false; });
    }

    return hostCall('save', { path: tab.path, text: tab.text })
      .then(function () {
        tab.savedText = tab.text;
        tab.dirty = false;
        renderTabs();
        updateWindowTitle();
        return true;
      })
      .catch(function (error) { toast(error.message, true); return false; });
  }

  // -------------------------------------------------------- 编辑器渲染

  var BLOCK_COMMENT_LANGS = {
    js: 1, ts: 1, java: 1, c: 1, cpp: 1, csharp: 1, cs: 1, go: 1, rust: 1, rs: 1, php: 1,
    css: 1, scss: 1, less: 1, sql: 1, swift: 1, kotlin: 1, kt: 1, json: 1, json5: 1,
  };
  var TRIPLE_LANGS = { python: 1, py: 1 };

  function codeLineState(lang) {
    var key = Highlight.normalize(lang || '') || '';
    return {
      block: !!BLOCK_COMMENT_LANGS[key],
      triple: TRIPLE_LANGS[key] ? '"' : null,
      open: false,
    };
  }

  function highlightCodeLine(line, lang, codeState) {
    if (!lang) { return esc(line); }

    if (codeState.block && codeState.open) {
      var end = line.indexOf('*/');
      if (end < 0) { return '<span class="tok-comment">' + esc(line) + '</span>'; }
      return '<span class="tok-comment">' + esc(line.slice(0, end + 2)) + '</span>' +
        Highlight.render(line.slice(end + 2), lang);
    }

    if (codeState.triple && codeState.open) {
      var close = line.indexOf('"""');
      if (close < 0) { return '<span class="tok-string">' + esc(line) + '</span>'; }
      return '<span class="tok-string">' + esc(line.slice(0, close + 3)) + '</span>' +
        Highlight.render(line.slice(close + 3), lang);
    }

    var rendered = Highlight.render(line, lang);

    if (codeState.block) {
      var opensAt = line.indexOf('/*');
      if (opensAt >= 0 && line.indexOf('*/', opensAt + 2) < 0) { codeState.open = true; }
    }
    if (codeState.triple && line.indexOf('"""') >= 0) {
      var parts = line.split('"""');
      if (parts.length % 2 === 0) { codeState.open = true; }
    }

    return rendered;
  }

  var INLINE_PATTERN = /(`+)([\s\S]*?)\1|(\*\*\*|___)(?=\S)([\s\S]*?\S)\3|(\*\*|__)(?=\S)([\s\S]*?\S)\5|(\*|_)(?=\S)([^*_\n]*?\S)\7|~~(?=\S)([\s\S]*?\S)~~|==(?=\S)([\s\S]*?\S)==|(!?)\[([^\]]*)\]\(([^)]*)\)|\$([^$\n]+)\$/g;

  function inlineMarkdown(text) {
    var out = '';
    var last = 0;
    var match;
    INLINE_PATTERN.lastIndex = 0;

    while ((match = INLINE_PATTERN.exec(text))) {
      out += esc(text.slice(last, match.index));
      if (match[1]) {
        out += '<span class="md-codetic">' + esc(match[0]) + '</span>';
      } else if (match[3] || match[5]) {
        out += '<span class="md-strong">' + esc(match[0]) + '</span>';
      } else if (match[7]) {
        out += '<span class="md-em">' + esc(match[0]) + '</span>';
      } else if (match[0].indexOf('~~') === 0) {
        out += '<span class="md-strike">' + esc(match[0]) + '</span>';
      } else if (match[0].indexOf('==') === 0) {
        out += '<span class="md-mark">' + esc(match[0]) + '</span>';
      } else if (match[11] != null) {
        out += '<span class="md-link">' + esc(match[0]) + '</span>';
      } else if (match[13] != null) {
        out += '<span class="md-math">' + esc(match[0]) + '</span>';
      } else {
        out += esc(match[0]);
      }
      last = match.index + match[0].length;
    }

    return out + esc(text.slice(last));
  }

  function markdownLine(line) {
    var match;

    // 先按第一个有意义的字符分派，再运行整套规则。所有规则都带锚点，因此以“这”
    // 开头的行绝不可能匹配标题、引用、列表、围栏或表格模式——markdown-it 的块级
    // 规则也是同样的组织方式（按首字符索引的规则链）。
    var probe = line.charCodeAt(0);
    var space = probe === 32 || probe === 9;
    var first = space ? line.charCodeAt(line.search(/\S/)) : probe;
    if (space && (Number.isNaN(first) || first < 0)) { return ''; }

    if (first === 35 && (match = /^(\s*)(#{1,6})(\s+)([\s\S]*)$/.exec(line))) {
      return match[1] + '<span class="md-marker">' + match[2] + '</span>' + match[3] +
        '<span class="md-h">' + inlineMarkdown(match[4]) + '</span>';
    }

    if (first === 62 && (match = /^(\s*)(>+\s?)([\s\S]*)$/.exec(line))) {
      return match[1] + '<span class="md-marker">' + esc(match[2]) + '</span>' +
        '<span class="md-quote">' + inlineMarkdown(match[3]) + '</span>';
    }

    if ((first === 45 || first === 42 || first === 95) && /^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      return '<span class="md-marker">' + esc(line) + '</span>';
    }

    var listish = first === 45 || first === 42 || first === 43 || (first >= 48 && first <= 57);
    if (listish && (match = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?([\s\S]*)$/.exec(line))) {
      return match[1] + '<span class="md-marker">' + esc(match[2]) + '</span>' + match[3] +
        (match[4] ? '<span class="md-marker">' + esc(match[4]) + '</span>' : '') +
        inlineMarkdown(match[5]);
    }

    if (first === 91 && (match = /^(\s*)(\[\^[^\]]+\]:\s*)([\s\S]*)$/.exec(line))) {
      return match[1] + '<span class="md-marker">' + esc(match[2]) + '</span>' + inlineMarkdown(match[3]);
    }

    if (first === 91 && (match = /^(\s*)(\[[^\]]+\]:\s*)(\S[\s\S]*)$/.exec(line))) {
      return match[1] + '<span class="md-marker">' + esc(match[2]) + '</span>' +
        '<span class="md-url">' + inlineMarkdown(match[3]) + '</span>';
    }

    if (first === 124 && /^\s*\|.*\|\s*$/.test(line)) {
      return '<span class="md-marker">' + esc(line) + '</span>';
    }

    if (first === 60 && /^\s*<[a-zA-Z/!]/.test(line)) {
      return '<span class="md-html">' + esc(line) + '</span>';
    }

    return inlineMarkdown(line);
  }

  /**
   * 给已经渲染好的行加上查找命中的标记。
   *
   * 这一行会先完全按无查找时的方式绘制，之后遍历它的文本节点再加上标记。这样能
   * 保留该行自身的样式：标题仍是标题，加粗仍是加粗，链接仍是链接。
   *
   * 区间以行为单位、按文档顺序传入；它们从后往前应用，这样一个文本节点被拆分
   * 不会让下一个节点的偏移量失效。
   */
  function wrapHits(lineElement, ranges, lineIndex) {
    var walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var at = 0;
    while (walker.nextNode()) {
      var text = walker.currentNode.nodeValue || '';
      nodes.push({ node: walker.currentNode, start: at, end: at + text.length });
      at += text.length;
    }
    if (!nodes.length) { return; }

    for (var i = ranges.length - 1; i >= 0; i--) {
      var from = ranges[i][0];
      var to = ranges[i][1];
      if (to <= from) { continue; }

      for (var n = nodes.length - 1; n >= 0; n--) {
        var entry = nodes[n];
        if (entry.end <= from || entry.start >= to) { continue; }

        var localFrom = Math.max(from, entry.start) - entry.start;
        var localTo = Math.min(to, entry.end) - entry.start;
        var node = entry.node;

        if (localTo < node.nodeValue.length) { node.splitText(localTo); }
        if (localFrom > 0) { node = node.splitText(localFrom); }

        var span = document.createElement('span');
        var current = findActive && findActive.line === lineIndex &&
          findActive.start === from && findActive.end === to;
        span.className = 'md-hit' + (current ? ' is-current' : '');
        node.parentNode.insertBefore(span, node);
        span.appendChild(node);
      }
    }
  }

  /** 高亮器的全部状态：尚未闭合的围栏及其词法分析器。 */
  function lineState() {
    return { fence: null, code: null };
  }

  function cloneState(state) {
    // 未处于任何代码围栏中的文档保持 `null` 状态，
    // 这使十万行的文件里逐行状态表依然开销很小。
    if (!state || (!state.fence && !state.code)) { return null; }
    return {
      fence: state.fence
        ? { char: state.fence.char, length: state.fence.length, lang: state.fence.lang } : null,
      code: state.code
        ? { block: state.code.block, triple: state.code.triple, open: state.code.open } : null,
    };
  }

  function sameState(a, b) {
    if (!a || !b) { return a === b; }
    if (!!a.fence !== !!b.fence || !!a.code !== !!b.code) { return false; }
    if (a.fence && (a.fence.char !== b.fence.char || a.fence.length !== b.fence.length ||
        a.fence.lang !== b.fence.lang)) { return false; }
    if (a.code && (a.code.block !== b.code.block || a.code.triple !== b.code.triple ||
        a.code.open !== b.code.open)) { return false; }
    return true;
  }

  /**
   * 单行的标记，以及下一行开始时所需的状态。
   *
   * 把过去整篇文档的循环拆成逐行处理，正是增量重绘得以实现的原因：一次编辑之后
   * 只重建文本或词法状态发生变化的行，而不是文件中的每一行。
   */
  function lineMarkup(line, state, findByLine, lineIndex, plain) {
    var next = cloneState(state);
    var fence = state ? state.fence : null;
    var code = state ? state.code : null;
    // 命中信息随标记一起传递，而不是直接切进标记里：调用方在将该行插入 DOM 之后
    // 再包装它们。把各个片段分别渲染——也就是过去的做法——会让任何含命中项的
    // 行丢失样式，因为 markdownLine() 是块级解析器，而半个标题并不是标题。
    // 被查找命中的加粗片段同样会把 `**` 变成普通文本。
    var ranges = findByLine ? findByLine.get(lineIndex) : null;
    var hits = ranges && ranges.length ? ranges : null;

    if (plain) { return { html: esc(line), state: next, hits: hits }; }

    if (fence) {
      var closer = new RegExp('^ {0,3}' + fence.char + '{' + fence.length + ',}[ \\t]*$');
      if (closer.test(line)) {
        return { html: '<span class="md-fence">' + esc(line) + '</span>', state: null, hits: hits };
      }
      // 传入的是*副本*：词法分析器会推进块注释的 `code.open`，
      // 改动缓存中的状态会污染下一次渲染。
      return { html: highlightCodeLine(line, fence.lang, next.code), state: next, hits: hits };
    }

    var opening = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/.exec(line);
    if (opening) {
      var opened = {
        char: opening[1].charAt(0),
        length: opening[1].length,
        lang: (opening[2] || '').trim(),
      };
      return {
        html: '<span class="md-fence">' + esc(opening[1]) + '</span>' +
          '<span class="md-url">' + esc(opening[2] || '') + '</span>',
        state: { fence: opened, code: codeLineState(opened.lang) },
        hits: hits,
      };
    }

    return { html: markdownLine(line), state: next, hits: hits };
  }

  // 当前位于 DOM 中的装饰节点，以及文档中真正以行元素绘制出来的那一段。
  //
  // CodeMirror 只绘制文档可见的部分（“外加一圈边距”），因为其他做法会让浏览器
  // 在每次按键时重新排版并重塑整个文件——在本机实测，3.4 万行的文件每次按键约
  // 260 ms，几乎全花在光标/选区的更新上。这里采用同样的思路：视口附近的行是真实
  // 元素，其余内容在上下两侧各合并成一段纯文本。textContent 仍然逐字呈现整个
  // 文档，因此选中、复制、撤销和差异比对逻辑都不受影响。
  var decoration = {
    text: null, lines: null, states: null, starts: null, plain: false,
    windowFirst: 0, windowLast: 0, windowBase: 0, windowNode: null,
    windowTop: 0, windowBottom: 0,
  };

  // 行数少于此值时就整体绘制：窗口维护的开销大于它节省的部分，
  // 而小文件才是常见情况。
  var WINDOW_THRESHOLD = 1200;
  var WINDOW_OVERSCAN = 2;
  var windowOfflineWarning = false;


  /**
   * 需要以元素形式绘制的行：视口范围加上一圈预扫描边距。
   *
   * 滚动位置会按*平均*行高（内容高度 / 行数）换算成行号；只要边距足够宽，
   * 即便存在折行也依然大致正确——下一次滚动时会再次校正窗口。
   */
  function computeWindow(lines, centreLine) {
    if (lines.length <= WINDOW_THRESHOLD) { return { first: 0, last: lines.length }; }

    var viewHeight = dom.editorScroll.clientHeight || 600;
    var contentHeight = dom.editorScroll.scrollHeight || 0;
    var average = contentHeight > 0 ? contentHeight / lines.length : 0;
    if (!(average > 4)) { average = editorLineHeight(); }

    var visible = Math.max(8, Math.ceil(viewHeight / average));
    var anchor = centreLine != null
      ? centreLine
      : Math.floor((dom.editorScroll.scrollTop || 0) / average);

    var first = Math.max(0, anchor - visible * WINDOW_OVERSCAN);
    var last = Math.min(lines.length, anchor + visible * (WINDOW_OVERSCAN + 1));
    return { first: first, last: last };
  }

  function lineIsRendered(index) {
    return index >= decoration.windowFirst && index < decoration.windowLast;
  }

  /** 某一行对应的 DOM 元素；该行位于折叠文本块中时返回 null。 */
  function lineNode(index) {
    if (!lineIsRendered(index)) { return null; }
    if (!decoration.windowNode) { return null; }
    return decoration.windowNode.childNodes[2 * (index - decoration.windowFirst)] || null;
  }

  /** 光标移到窗口之外时，围绕该行重新渲染窗口。 */
  function ensureWindowForOffset(offset) {
    if (!decoration.lines || decoration.lines.length <= WINDOW_THRESHOLD) { return; }
    if (!decoration.starts) { return; }
    var line = lineIndexOfOffset(offset);
    if (lineIsRendered(line)) { return; }
    fullEditorRenderAt(decoration.text, decoration.lines, decoration.plain,
      state.find.byLine.size ? state.find.byLine : null, line);
  }

  /** 滚动距离大到已绘制的窗口不再覆盖可视区域。 */
  function refreshWindowForScroll() {
    if (!decoration.lines || decoration.lines.length <= WINDOW_THRESHOLD) { return; }
    if (decoration.windowFirst === 0 && decoration.windowLast === decoration.lines.length) { return; }

    var plan = computeWindow(decoration.lines, null);
    if (plan.first >= decoration.windowFirst && plan.last <= decoration.windowLast) { return; }

    fullEditorRenderAt(decoration.text, decoration.lines, decoration.plain,
      state.find.byLine.size ? state.find.byLine : null, null);
  }

  /**
   * 每一行首字符的字符偏移量，末尾再追加一个表示文档结尾的条目。
   *
   * 过去计算光标位置要遍历整个编辑区（TreeWalker 加 Range.toString()），
   * 每敲一次键的费用就是整篇文档。有了这个索引，定位行变成一次二分查找，
   * 行内位置则只需在该行自己的文本节点上做一次很短的遍历。
   */
  function computeLineStarts(lines, from) {
    var previous = decoration.starts;
    var starts = previous && previous.length === lines.length + 1 ? previous : null;
    var index = Math.max(0, Math.min(from || 0, lines.length));

    if (!starts) {
      starts = new Array(lines.length + 1);
      for (var copy = 0; copy <= index && previous && copy < previous.length; copy++) {
        starts[copy] = previous[copy];
      }
    }
    if (index === 0) { starts[0] = 0; }

    for (var i = index; i < lines.length; i++) {
      starts[i + 1] = starts[i] + lines[i].length + 1;
    }
    return starts;
  }

  /** 包含指定字符偏移量的行号。 */
  function lineIndexOfOffset(offset) {
    var starts = decoration.starts;
    if (!starts || starts.length < 2) { return 0; }
    var low = 0;
    var high = starts.length - 2;
    while (low < high) {
      var mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) { low = mid; } else { high = mid - 1; }
    }
    return low;
  }

  function renderEditorContent(text, force) {
    var value = String(text == null ? '' : text);
    if (!force && decoration.text === value) { return; }

    var lines = value.split('\n');
    var plain = value.length > 600000;
    var find = state.find.byLine.size ? state.find.byLine : null;

    if (force || !decoration.lines || decoration.plain !== plain || decoration.lines.length === 0) {
      fullEditorRender(value, lines, plain, find);
      return;
    }

    // 行级差异比对：`up` 之前和 `down*` 之后的内容完全相同。
    var oldLines = decoration.lines;
    var up = 0;
    var shortest = Math.min(oldLines.length, lines.length);
    while (up < shortest && oldLines[up] === lines[up]) { up++; }

    var downOld = oldLines.length;
    var downNew = lines.length;
    while (downOld > up && downNew > up && oldLines[downOld - 1] === lines[downNew - 1]) {
      downOld--;
      downNew--;
    }

    // 改动落在已绘制窗口之外（全部替换、在很远处粘贴）：
    // 围绕该位置重新渲染窗口，而不是去修补一段文本块。
    if (!lineIsRendered(up) || up >= decoration.windowLast) {
      fullEditorRenderAt(value, lines, plain, find, up);
      return;
    }

    // 只要高亮状态与缓存不一致就继续向后重绘——输入一个围栏起始标记，会让它到
    // 结束标记之间的所有内容都改变样式。（变量名用 `lexer`：局部变量若叫
    // `state`，会在整个函数作用域内遮蔽应用状态对象，变量提升也算在内。）
    var lexer = up > 0 ? cloneState(decoration.states[up]) : lineState();
    var markup = [];
    var at = up;
    while (at < lines.length) {
      var step = lineMarkup(lines[at], lexer, find, at, plain);
    markup.push(step);
      lexer = step.state;
      at++;

      if (at >= downNew) {
        var oldIndex = downOld + (at - downNew);
        if (oldIndex >= 0 && oldIndex < decoration.states.length &&
            sameState(lexer, decoration.states[oldIndex])) {
          break;
        }
      }
    }

    if (at > decoration.windowLast) {
      fullEditorRenderAt(value, lines, plain, find, up);
      return;
    }

    var suffixStart = downOld + (at - downNew);
    // 移除旧文档中该区域覆盖的全部内容，而不只是到第一个相同的后缀行为止：
    // `downOld` 与 `suffixStart` 之间的行也被重新渲染过了。
    replaceLineRegion(up, suffixStart, at, lines, markup, oldLines.length);

    // 廉价的结构自检：子节点序列总是 `span, "\n", span, …`，
    // 任何记账错误都会在这里暴露出来，而不是慢慢把编辑区弄坏。
    // 退回整体渲染永远是安全的。
    if (dom.editor.childNodes.length !== 2 * lines.length - 1) {
      fullEditorRender(value, lines, plain, find);
      return;
    }

    decoration.text = value;
    decoration.lines = lines;
    decoration.plain = plain;
    decoration.starts = computeLineStarts(lines, up);
    decoration.states = decoration.states.slice(0, up).concat(
      collectStates(up, at, lines, up > 0 ? decoration.states[up] : null, find, plain),
      decoration.states.slice(Math.max(up, suffixStart)));
  }

  /**
   * 重新计算刚渲染区域的每一行之前的高亮状态。缓存数组末尾多出一个条目——
   * 即最后一行的状态——这样向文档追加内容时有起点可依，而不会越过数组末尾。
   */
  function collectStates(from, to, lines, startState, find, plain) {
    var state = startState ? cloneState(startState) : lineState();
    var out = [];
    for (var i = from; i < to; i++) {
      out.push(cloneState(state));
      state = lineMarkup(lines[i], state, find, i, plain).state;
    }
    return out;
  }

  /**
   * 替换一段行节点。子节点序列总是
   * `span.line, "\n", span.line, "\n", … span.line`，
   * 因此第 i 行的节点位于索引 2i，每个分隔符位于 2i+1。
   */
  function replaceLineRegion(up, removeEnd, renderEnd, lines, markup, oldLineCount) {
    var host = decoration.windowNode || dom.editor;
    var children = host.childNodes;
    var firstNode = Math.min(2 * (up - decoration.windowFirst), children.length);
    var lastNode = Math.min(2 * (removeEnd - decoration.windowFirst), children.length);
    var anchor = children[firstNode] || null;

    var removing = [];
    for (var k = firstNode; k < lastNode; k++) { removing.push(children[k]); }

    var fragment = document.createDocumentFragment();
    // 起始位置正好是旧文档结尾的区域，前面还没有分隔符（原来的最后一行没有），
    // 因此需要自带一个。
    if (up > 0 && oldLineCount != null && up >= oldLineCount) {
      fragment.appendChild(document.createTextNode('\n'));
    }
    for (var i = up; i < renderEnd; i++) {
      var line = document.createElement('span');
      line.className = 'line';
      var step = markup[i - up];
      line.innerHTML = (step && step.html) || '';
      if (step && step.hits) { wrapHits(line, step.hits, i); }
      fragment.appendChild(line);
      // 换行保留为真实的文本节点，这样 textContent 就是文档本身。
      if (i < lines.length - 1) { fragment.appendChild(document.createTextNode('\n')); }
    }

    if (anchor) { host.insertBefore(fragment, anchor); }
    else { host.appendChild(fragment); }
    for (var r = 0; r < removing.length; r++) { host.removeChild(removing[r]); }
  }

  function fullEditorRender(value, lines, plain, find) {
    return fullEditorRenderAt(value, lines, plain, find, caretLineHint());
  }

  /** 光标当前所在的行，用于让它保持在已绘制的窗口内。 */
  function caretLineHint() {
    var offsets = decoration.starts ? readCaretOffsets() : null;
    return offsets ? lineIndexOfOffset(offsets.start) : null;
  }

  function fullEditorRenderAt(value, lines, plain, find, centreLine) {
    /*
     * 替换窗口之前，记录读者正在看的位置。
     *
     * 已绘制窗口上下两段的文本用估算高度代替，因此把其中一段换成真实行会改变
     * 内容高度，而浏览器会保持 `scrollTop` 不变——结果就是视口下的文字发生滑动。
     * 把同一行放回原处即可阻止这种滑动；否则滚动时重绘窗口会让视图每帧都挪一点。
     * 仅适用于由滚动触发的渲染：要求以某一行（光标、查找命中）为中心的渲染本来就
     * 应当移动视图。
     */
    var keepAnchor = centreLine == null && decoration.lines ? editorViewportAnchor() : null;
    // 替换窗口之前，面板是否停在自身末尾。代替窗口外各行的折叠块按不折行文本
    // 估算尺寸，因此把它们换成真实行会让含折行的文档变高——此时仍停在旧偏移量的
    // 面板就不再位于末尾，这正是“已经滚到底却还能继续滚”的由来。
    // 重绘之后会把位置还原。
    var wasAtEnd = paneAtEnd(dom.editorScroll);
    // 替换窗口前面板所在的位置，这样只有确实是重建造成的钳制才被算作我们的调整。
    var heldTop = dom.editorScroll.scrollTop;

    var plan = computeWindow(lines, centreLine);
    var sameText = decoration.text === value && decoration.states &&
      decoration.states.length === lines.length + 1;
    var states = sameText ? decoration.states : new Array(lines.length + 1);
    var markup = new Array(plan.last - plan.first);
    var state = sameText ? states[plan.first] : null;
    var at = plan.first;

    if (sameText) {
      // 滚动只改变绘制哪些行：高亮状态依然有效，
      // 因此窗口之外的内容无需重新做词法分析。
      for (; at < plan.last; at++) {
        var step = lineMarkup(lines[at], state, find, at, plain);
        markup[at - plan.first] = step;
        state = step.state;
      }
    } else {
      for (var i = 0; i < lines.length; i++) {
        states[i] = cloneState(state);
        var walked = lineMarkup(lines[i], state, find, i, plain);
        if (i >= plan.first && i < plan.last) { markup[i - plan.first] = walked; }
        state = walked.state;
      }
      states[lines.length] = cloneState(state);
    }

    var fragment = document.createDocumentFragment();
    var base = 0;
    var window = null;

    // 窗口上方的一切都会合并成一个文本节点。它仍然逐字包含那些行
    // （因此 textContent、全选和复制都不受影响），
    // 但对浏览器来说只是跑一段文本，而不是成千上万个元素。
    if (plan.first > 0) {
      fragment.appendChild(makeFold(lines.slice(0, plan.first).join('\n') + '\n', plan.first, centreLine != null));
    }

    window = document.createElement('div');
    window.className = 'entry-window';
    // 行号从上方折叠块结束的地方继续。
    window.setAttribute('style', 'counter-reset: mn-line ' + plan.first);
    for (var j = plan.first; j < plan.last; j++) {
      var line = document.createElement('span');
      line.className = 'line';
      var step = markup[j - plan.first];
      line.innerHTML = (step && step.html) || '';
      if (step && step.hits) { wrapHits(line, step.hits, j); }
      window.appendChild(line);
      if (j < lines.length - 1) { window.appendChild(document.createTextNode('\n')); }
    }
    fragment.appendChild(window);

    if (plan.last < lines.length) {
      fragment.appendChild(makeFold(lines.slice(plan.last).join('\n'), lines.length - plan.last, false));
    }

    dom.editor.textContent = '';
    dom.editor.appendChild(fragment);

    decoration.text = value;
    decoration.lines = lines;
    decoration.states = states;
    decoration.plain = plain;
    if (!sameText) { decoration.starts = computeLineStarts(lines, 0); }
    decoration.windowFirst = plan.first;
    decoration.windowLast = plan.last;
    decoration.windowBase = base;
    decoration.windowNode = window;

    // 第一个已绘制行在可滚动内容中的位置。这里本来就要算一次布局，因此这个值
    // 是顺带得到的——也避免了 `viewportTopLine` 在每一帧滚动时都强制触发布局。
    var firstRow = window.firstElementChild;
    if (firstRow) {
      decoration.windowTop = firstRow.getBoundingClientRect().top -
        dom.editorScroll.getBoundingClientRect().top + dom.editorScroll.scrollTop;
    }
    var lastRow = window.lastElementChild;
    if (lastRow) {
      decoration.windowBottom = lastRow.getBoundingClientRect().bottom -
        dom.editorScroll.getBoundingClientRect().top + dom.editorScroll.scrollTop;
    }

    if (keepAnchor) { restoreEditorAnchor(keepAnchor); }
    if (wasAtEnd) { pinPaneToEnd(dom.editorScroll); }
    // 与预览的占位元素同理：把折叠段换成真实行会改变内容高度，因此只有确实是
    // 浏览器钳制过的位置才记作我们放置的——*仅*在这种情况下才记。无条件声明位置
    // 会让这个声明比钳制存留得更久：接下来的滚动事件（不论来自读者还是浏览器）
    // 发现面板已经停在这个数值上，就被当作回声丢弃。Ctrl+End 把本窗格移动了一屏
    // 却把阅读窗格落在后面，就是这么来的。
    if (dom.editorScroll.scrollTop !== heldTop) {
      placedEditorAt = Date.now();
      placedEditorValue = dom.editorScroll.scrollTop;
    }
  }

  /** 把源位置 `anchor` 放回编辑器窗格的顶部。 */
  function restoreEditorAnchor(anchor) {
    var node = lineNode(Math.floor(anchor.line) - 1);
    if (!node) { return; }
    var paneTop = dom.editorScroll.getBoundingClientRect().top;
    var rect = node.getBoundingClientRect();
    var wanted = dom.editorScroll.scrollTop + (rect.top - paneTop) + anchor.fraction * rect.height;
    var delta = wanted - (anchor.at == null ? wanted : anchor.at);
    if (Math.abs(delta) < 1) { return; }
    // 这是我们放置的，不是读者滚动的：同步逻辑不能跟随这次校正。这里只抵消高度
    // 变化，因此读者在窗口重建期间所做的滚动仍会保留。
    placedEditorAt = Date.now();
    dom.editorScroll.scrollTop = Math.max(0, dom.editorScroll.scrollTop + delta);
    placedEditorValue = dom.editorScroll.scrollTop;
  }

  /**
   * 一段不以元素形式绘制的行。
   *
   * `content-visibility: auto` 是浏览器自带的“不排版屏幕外内容”（MDN：它
   * “使用户代理可以跳过元素的渲染工作，包括布局和绘制，直到需要时才进行”），
   * `contain-intrinsic-size: auto` 则让它记住上次测得的尺寸。文本仍留在 DOM 中，
   * 因此 textContent、全选和复制都不受影响——只是跳过了布局工作。
   */
  function makeFold(text, lineCount, nearCaret) {
    var fold = document.createElement('div');
    fold.className = 'entry-fold' + (nearCaret ? ' is-near' : '');
    var lineHeight = editorLineHeight();
    fold.setAttribute('style', 'contain-intrinsic-size: auto ' +
      Math.max(1, Math.round(lineCount * lineHeight)) + 'px');
    fold.appendChild(document.createTextNode(text));
    return fold;
  }

  // ------------------------------------------------- 编辑区适配层
  //
  // 应用其余部分当初是按 textarea 的语义编写的。与其改写每一处调用，不如在
  // contenteditable 之上提供同一套小接口，让文本与光标共用同一批 DOM 节点——
  // Typora 和 CodeMirror 6 采用的正是这种做法，也正是绘制的叠加层不会再与光标
  // 错位的原因。

  function editorText() {
    return dom.editor.textContent;
  }

  /** DOM 位置的字符偏移量，以某一行的元素为基准测量。 */
  function offsetWithinLine(element, node, offset) {
    var range = document.createRange();
    range.selectNodeContents(element);
    try { range.setEnd(node, offset); } catch (error) { return 0; }
    return range.toString().length;
  }

  /** 容纳该节点的行元素，通过对子节点二分查找得到。 */
  function lineElementOf(node) {
    if (!decoration.windowNode) { return { element: null, index: -1 }; }
    var children = decoration.windowNode.childNodes;
    var count = decoration.windowLast - decoration.windowFirst;
    if (count <= 0) { return { element: null, index: -1 }; }

    var low = 0;
    var high = count - 1;
    while (low <= high) {
      var mid = (low + high) >> 1;
      var span = children[2 * mid];
      if (!span) { break; }
      var relation = span.compareDocumentPosition(node);
      if (relation & Node.DOCUMENT_POSITION_CONTAINED_BY) {
        return { element: span, index: decoration.windowFirst + mid };
      }
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) { low = mid + 1; } else { high = mid - 1; }
    }
    return { element: null, index: -1 };
  }

  /** DOM 位置在整个编辑区中的字符偏移量。 */
  function offsetWithin(node, offset) {
    // 第一次装饰处理之前还没有可用的索引；这条慢路径只在启动阶段执行。
    if (!decoration.starts || !decoration.lines) {
      var probe = document.createRange();
      probe.selectNodeContents(dom.editor);
      try { probe.setEnd(node, offset); } catch (error) { return 0; }
      return probe.toString().length;
    }

    // 直接位于编辑器元素上的光标处在两个子节点之间：偶数偏移量表示某行的开始，
    // 奇数偏移量表示某行的结束。
    if (node === dom.editor) {
      var line = Math.min(Math.max(0, offset >> 1), decoration.lines.length - 1);
      return decoration.starts[line] + ((offset % 2) ? decoration.lines[line].length : 0);
    }

    var found = lineElementOf(node);
    if (found.element) {
      return (decoration.starts[found.index] || 0) + offsetWithinLine(found.element, node, offset);
    }

    // 光标位于某个折叠文本块内部：从编辑区顶部开始测量
    // （很少见——光标通常都在已绘制的窗口里）。
    var blobRange = document.createRange();
    blobRange.selectNodeContents(dom.editor);
    try { blobRange.setEnd(node, offset); } catch (error) { return 0; }
    return blobRange.toString().length;
  }

  function readCaretOffsets() {
    return readCaretOffsetsInner();
  }

  function readCaretOffsetsInner() {
    var selection = document.getSelection();
    if (!selection || !selection.rangeCount) { return null; }
    var range = selection.getRangeAt(0);
    if (!dom.editor.contains(range.startContainer)) { return null; }
    return {
      start: offsetWithin(range.startContainer, range.startOffset),
      end: offsetWithin(range.endContainer, range.endOffset),
    };
  }

  function locateOffset(offset) {
    return locateOffsetInner(offset);
  }

  function locateOffsetInner(offset) {
    if (decoration.starts && decoration.lines && dom.editor.childNodes.length) {
      var line = lineIndexOfOffset(offset);
      var span = lineNode(line);
      if (!span) {
        // 位于折叠文本块内部：直接定位到该文本块自身的文本节点。
        var before = line < decoration.windowFirst;
        var fold = dom.editor.childNodes[before ? 0 : dom.editor.childNodes.length - 1];
        var blob = fold && fold.firstChild;
        if (fold === decoration.windowNode) {
          // 光标在文档内，但该行没有被绘制：退回到相邻的已绘制行，
          // 而不是编辑区元素本身（光标需要依附于文本节点）。
          if (!windowOfflineWarning) {
            windowOfflineWarning = true;
            hostCall('log', {
              line: 'window: caret line ' + line + ' outside [' + decoration.windowFirst + ',' +
                decoration.windowLast + ') of ' + decoration.lines.length,
            }).catch(function () {});
          }
          var near = lineNode(Math.min(Math.max(line, decoration.windowFirst), decoration.windowLast - 1));
          if (near) {
            var tail = near.lastChild;
            if (tail && tail.nodeType === Node.TEXT_NODE) {
              return { node: tail, offset: tail.nodeValue.length };
            }
            return { node: near, offset: 0 };
          }
          return { node: dom.editor, offset: 0 };
        }
        if (blob && blob.nodeType === Node.TEXT_NODE) {
          var blobStart = decoration.starts[before ? 0 : decoration.windowLast] || 0;
          return { node: blob, offset: Math.max(0, offset - blobStart) };
        }
        return { node: dom.editor, offset: 0 };
      }

      var remaining = Math.max(0, offset - (decoration.starts[line] || 0));
      var walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT, null);
      var node = walker.nextNode();
      var last = null;
      while (node) {
        var length = node.nodeValue.length;
        if (remaining <= length) { return { node: node, offset: remaining }; }
        remaining -= length;
        last = node;
        node = walker.nextNode();
      }
      return last ? { node: last, offset: last.nodeValue.length } : { node: span, offset: 0 };
    }

    var fallback = Math.max(0, offset);
    var walker = document.createTreeWalker(dom.editor, NodeFilter.SHOW_TEXT, null);
    var node = walker.nextNode();
    var last = node;

    while (node) {
      var length = node.nodeValue.length;
      if (fallback <= length) { return { node: node, offset: fallback }; }
      fallback -= length;
      last = node;
      node = walker.nextNode();
    }

    return last ? { node: last, offset: last.nodeValue.length } : { node: dom.editor, offset: 0 };
  }

  function placeCaret(start, end) {
    return placeCaretInner(start, end);
  }

  var lastCaret = { start: 0, end: 0 };

  function placeCaretInner(start, end) {
    // 让光标所在行保持在已绘制的窗口内，否则光标会落进折叠文本块
    // （而它需要的那一行并不存在）。
    ensureWindowForOffset(start);

    // 记住光标的放置位置。只要另一个控件获得焦点（查找框就会），Chromium 就会
    // 丢弃编辑器的 DOM 选区，之后再读就无从读取，而用户应当返回的位置仍然是这里。
    lastCaret = { start: start, end: end == null ? start : end };

    var selection = document.getSelection();
    if (!selection) { return; }
    var from = locateOffset(start);
    var to = locateOffset(end == null ? start : end);
    var range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function installEditorSurface() {
    Object.defineProperty(dom.editor, 'value', {
      configurable: true,
      get: function () { return editorText(); },
      set: function (text) {
        renderEditorContent(text == null ? '' : String(text));
        placeCaret(editorText().length, editorText().length);
      },
    });

    Object.defineProperty(dom.editor, 'selectionStart', {
      configurable: true,
      get: function () { var offsets = readCaretOffsets(); return offsets ? offsets.start : 0; },
    });

    Object.defineProperty(dom.editor, 'selectionEnd', {
      configurable: true,
      get: function () { var offsets = readCaretOffsets(); return offsets ? offsets.end : 0; },
    });

    dom.editor.setSelectionRange = function (start, end) {
      placeCaret(start, end == null ? start : end);
    };

    dom.editor.setRangeText = function (text, start, end, mode) {
      var value = editorText();
      var from = Math.max(0, Math.min(start, value.length));
      var to = Math.max(from, Math.min(end == null ? value.length : end, value.length));
      var next = value.slice(0, from) + text + value.slice(to);
      renderEditorContent(next);
      if (mode === 'end') { placeCaret(from + text.length, from + text.length); }
      else { placeCaret(from, from + text.length); }
      return next;
    };

    // 编辑器中的 Ctrl+A 和右键菜单里的“全选”都会调用 select()，
    // 这是 textarea 有而本编辑区没有的方法。当初只是漏在了适配层里，
    // 导致两条路径都还没选中任何内容就先抛了异常。
    dom.editor.select = function () {
      placeCaret(0, editorText().length);
    };
  }

  var highlightFrame = 0;
  function scheduleHighlight() {
    if (highlightFrame) { return; }
    highlightFrame = requestAnimationFrame(function () {
      highlightFrame = 0;
      renderHighlightNow();
    });
  }

  /**
   * 重绘装饰内容，并把光标保持在用户留下的位置。不传 `force` 时，
   * 只重建文本或词法状态发生变化的行。
   */
  function renderHighlightNow(force) {
    var offsets = readCaretOffsets();
    renderEditorContent(editorText(), force);
    if (offsets) { placeCaret(offsets.start, offsets.end); }
  }

  /**
   * 编辑区会随内容自动增高，因此列宽变化无需在这里做高度记账——
   * 只有打字机滚动需要跟随。
   */
  function relayoutEditor() {
    if (state.config && state.config.typewriter) { typewriterFollow(); }
  }

  // -------------------------------------------------------------- 渲染

  function resolveUrl(url) {
    if (!url) { return url; }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.indexOf('//') === 0 || url[0] === '#') { return url; }

    var suffix = '';
    var hashAt = url.indexOf('#');
    if (hashAt >= 0) { suffix = url.slice(hashAt); url = url.slice(0, hashAt); }
    var queryAt = url.indexOf('?');
    if (queryAt >= 0) { suffix = url.slice(queryAt) + suffix; url = url.slice(0, queryAt); }

    var clean = url.replace(/^\.\//, '').replace(/^[\\/]+/, '');
    if (!clean) { return url + suffix; }

    var encoded = clean.split('/').map(function (part) {
      return encodeURIComponent(part);
    }).join('/');

    // 由原生端直接从当前笔记所在目录提供。
    return 'https://cnote.localhost/@doc/' + encoded + suffix;
  }

  var renderTimer = 0;
  function schedulePreview() {
    clearTimeout(renderTimer);
    // 大文档的排版开销很高，因此重建预览前的静默期更长；
    // 无论哪种情况，输入都保持跟手。
    var length = (activeTab() && activeTab().text.length) || 0;
    var delay = length > 400000 ? 400 : (length > 120000 ? 200 : 90);
    renderTimer = setTimeout(renderPreview, delay);
  }

  // ------------------------------------------------------------ 安全过滤

  // Markdown 允许携带原始 HTML，而本预览与原生桥接（文件读写、导出 PDF）
  // 同源。从互联网下载的笔记绝不能借此操纵该桥接，因此所有渲染内容都先解析进
  // 一个不执行的 <template>，再裁剪为安全子集。
  var SAFE_TAGS = {
    a: 1, abbr: 1, b: 1, blockquote: 1, br: 1, caption: 1, cite: 1, code: 1, col: 1,
    colgroup: 1, dd: 1, del: 1, details: 1, dfn: 1, div: 1, dl: 1, dt: 1, em: 1,
    figcaption: 1, figure: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, hr: 1, i: 1,
    img: 1, ins: 1, input: 1, kbd: 1, li: 1, mark: 1, ol: 1, p: 1, picture: 1, pre: 1,
    q: 1, s: 1, samp: 1, section: 1, small: 1, source: 1, span: 1, strong: 1, sub: 1, nav: 1,
    summary: 1, sup: 1, table: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, time: 1,
    tr: 1, u: 1, ul: 1, var: 1, audio: 1, video: 1,
  };

  // 连同其内容一起移除。
  var DROP_TAGS = {
    script: 1, style: 1, iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1, applet: 1,
    form: 1, button: 1, select: 1, textarea: 1, option: 1, link: 1, meta: 1, base: 1,
    title: 1, noscript: 1, template: 1, svg: 1, canvas: 1, portal: 1,
  };

  var SAFE_ATTRS = {
    href: 1, src: 1, alt: 1, title: 1, class: 1, id: 1, colspan: 1, rowspan: 1,
    start: 1, type: 1, checked: 1, disabled: 1, width: 1, height: 1, loading: 1,
    'data-line': 1, 'data-lang': 1, 'data-fn': 1, 'data-fnback': 1, lang: 1, dir: 1,
  };

  var SAFE_MATH_ATTRS = {
    display: 1, stretchy: 1, fence: 1, largeop: 1, movablelimits: 1, width: 1,
    linebreak: 1, accent: 1, mathvariant: 1, linethickness: 1, lspace: 1, rspace: 1,
    columnalign: 1, form: 1, separator: 1,
  };

  var MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
  var HTML_NS = 'http://www.w3.org/1999/xhtml';

  function sanitizeHtml(html) {
    var template = document.createElement('template');
    template.innerHTML = String(html == null ? '' : html);
    scrub(template.content);
    return template.innerHTML;
  }

  function scrub(root) {
    Array.prototype.slice.call(root.childNodes).forEach(function (node) {
      if (node.nodeType === Node.COMMENT_NODE) { node.remove(); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) { return; }

      if (node.namespaceURI === MATHML_NS) { scrubMath(node); return; }
      if (node.namespaceURI !== HTML_NS) { node.remove(); return; }

      var tag = node.localName;

      if (DROP_TAGS[tag]) { node.remove(); return; }

      if (!SAFE_TAGS[tag]) {
        scrub(node);
        unwrap(node);
        return;
      }

      if (tag === 'input' && (node.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
        node.remove();
        return;
      }

      scrub(node);
      Array.prototype.slice.call(node.attributes).forEach(function (attribute) {
        if (!SAFE_ATTRS[attribute.name]) { node.removeAttribute(attribute.name); }
      });
      stripDangerousUrls(node);
    });
  }

  function scrubMath(node) {
    if (node.localName === 'script' || node.localName === 'annotation-xml') {
      node.remove();
      return;
    }

    scrub(node);
    Array.prototype.slice.call(node.attributes).forEach(function (attribute) {
      if (!SAFE_MATH_ATTRS[attribute.name]) { node.removeAttribute(attribute.name); }
    });
  }

  function stripDangerousUrls(node) {
    ['href', 'src', 'srcset', 'poster'].forEach(function (name) {
      var value = node.getAttribute(name);
      if (value && /^[\s\u0000-\u001f]*(javascript|vbscript|data:text\/html)/i.test(value)) {
        node.removeAttribute(name);
      }
    });
  }

  function unwrap(node) {
    var parent = node.parentNode;
    if (!parent) { return; }
    while (node.firstChild) { parent.insertBefore(node.firstChild, node); }
    parent.removeChild(node);
  }

  /**
   * 预览窗格当前显示的内容。
   *
   * `blocks` 是构建 DOM 所用的块级 HTML，`chunks` 是每个块生成的节点。同时保留
   * 两者，才使长文档中的输入变得可负担：一次按键通常只改变一个块，因此共同的前缀
   * 和后缀保持不动，只重建中间部分。过去每敲一次键都把整篇文档重新解析成十万个
   * 全新元素，在 1.5 MB 的文档上要花掉一秒多。
   */
  var previewDoc = {
    tabId: 0,
    blocks: [],    // 块级 HTML，顺序与文档一致
    spans: [],     // 每个块占用的源码行数，用于初次高度估算
    starts: [],    // 每个块的起始源码行，用于“滚动到标题”
    ends: [],      // 每个块的结束源码行，用于行与块的相互查找
    heights: [],   // 绘制后为实测高度，绘制前为估算值
    chunks: [],    // 当前在 DOM 中的块对应的节点数组（否则为 null）
    // prefix[i] 是块 [0, i) 的总高度，`dirtyFrom` 是它开始失效的第一个下标——
    // 过去用一个游标边遍历边累加，某个高度发生变化时无从察觉，
    // 其后的所有位置都会偏移。
    prefix: [],
    dirtyFrom: 0,
    from: 0,
    to: 0,
    // 缓存起来，这样分栏同步读取时不必强制触发布局。
    scrollHeight: 0,
  };

  /**
   * 视口之外仍保持绘制的范围，单位为像素。
   *
   * 这就是 CodeMirror 的视口模型（System Guide 的 “Viewport”）：绘制屏幕内容加
   * 一圈边距，其余部分只保留高度信息——先估算，块真正绘制后再用实测值替换。
   * 另一种做法，也就是过去采用的，是一次性构建全部块：2 MB 的笔记会生成
   * 21 万个元素、占用约 770 MB 渲染进程内存。
   */
  var PREVIEW_MARGIN_PX = 900;

  /** 块 `i` 的渲染高度，绘制后为实测值。 */
  function blockHeight(index) {
    var height = previewDoc.heights[index];
    if (height) { return height; }
    // 尚未绘制。来自更多源码行的块更高；在真实数值到来之前，窗口就用这个估算值，
    // 块一旦绘制完成，该数值立即被实测值取代。
    height = 26 + (previewDoc.spans[index] || 1) * 24;
    previewDoc.heights[index] = height;
    return height;
  }

  /**
   * `index` 之前所有块的总高度。
   *
   * 一张按需向后扩展的前缀表，外加一个显式的“从这里开始失效”下标。它取代的游标
   * 方式维护一个滚动偏移量，并在位于它*之前*的块被测量时作出调整——只要它下面的
   * 东西不变就是对的，可一旦变化，由它推导出的每个位置都会悄悄地错掉（阅读窗格
   * 与源码相差整整一节，就是这样来的）。这张表只允许向后扩展，
   * 失效点之后的部分绝不采信。
   */
  function previewPrefix(index) {
    var count = previewDoc.blocks.length;
    var prefix = previewDoc.prefix;
    if (prefix.length !== count + 1) {
      prefix = previewDoc.prefix = new Array(count + 1);
      prefix[0] = 0;
      previewDoc.dirtyFrom = 0;
    }

    var need = Math.min(count, index) + 1;
    for (var i = previewDoc.dirtyFrom; i < need; i++) {
      prefix[i + 1] = prefix[i] + blockHeight(i);
    }
    if (previewDoc.dirtyFrom < need) { previewDoc.dirtyFrom = need; }
    return prefix[index] || 0;
  }

  /** 块 `index` 获得新高度时调用。 */
  function markPreviewHeightDirty(index) {
    if (index < previewDoc.dirtyFrom) { previewDoc.dirtyFrom = index; }
  }

  /** 一个块的 HTML 展开后得到的 DOM 节点。 */
  function blockChunk(html) {
    var template = document.createElement('template');
    template.innerHTML = html;
    return Array.prototype.slice.call(template.content.childNodes);
  }

  /**
   * 让已绘制的集合与视口保持一致。
   *
   * `anchorLine` 是要回到的源码位置，用于块列表本身发生变化、旧的滚动偏移量已不再
   * 表示同一处的情况；不传时则根据当前偏移量读取位置。
   *
   * 滚动范围由上下两个占位元素撑开，而不是每个块一个占位元素：2 MB 的笔记有两万
   * 三千个块，一一块一个占位就等于虚拟化本要避免的那两万三千个元素。窗口上方和
   * 下方各一个占位元素承载所有未绘制内容的高度，
   * 这也是 CodeMirror 的尺寸器所采用的形式。
   *
   * 高度在首次出现时估算，块绘制完成后替换为实测值，
   * 因此随着读者浏览文档，滚动条会越来越准确。
   */
  function layoutPreview(anchorLine, wasAtEnd) {
    var view = dom.previewScroll;
    var blocks = previewDoc.blocks;
    if (!view || !dom.previewTop) { return; }
    if (!blocks.length) {
      dom.previewTop.style.height = '0px';
      dom.previewBottom.style.height = '0px';
      return;
    }

    // 在任何内容移动之前，先锚定视口顶部正在显示的位置。某个块把估算高度换成实测
    // 高度，会改变它下方所有内容的高度；没有这一步，读者的位置会随着每次滚动
    // 一点点漂移。
    var anchor = anchorLine || previewAnchorLine();
    // 停在文档末尾的面板应继续保持在那里：下面写入的占位元素会用刚绘制的块替换
    // 未测量的块，从而改变面板下方的内容高度。
    //
    // 当调用方刚刚丢弃了所有块时，这个答案必须由调用方给出：`clearPreview()` 会让
    // 占位元素短暂为空，于是面板自身的滚动范围塌缩为零，*任何*位置看起来都像末尾
    // ——这正是编辑时第一次按键就让阅读窗格莫名其妙钉在文档末尾的原因。
    if (wasAtEnd === undefined) { wasAtEnd = paneAtEnd(view); }

    /*
     * 最多两轮：绘制会测量它排版的块，而锚点之上的一次测量会让刚写入的占位元素
     * 恰好偏差这么多。只有在锚点之上确实发生变化时才跑第二轮，这正是读者对着
     * 未测量文本滚动时每一帧都在发生的事——也正是过去阅读窗格与源码相差几行、
     * 直到下一次滚动事件才被纠正的原因。
     */
    for (var pass = 0; pass < 4; pass++) {
      var dirtyBefore = previewDoc.dirtyFrom;

      var top = view.scrollTop - PREVIEW_MARGIN_PX;
      var bottom = view.scrollTop + view.clientHeight + PREVIEW_MARGIN_PX;

      // 窗口与两个占位元素的高度全部取自前缀表：它取代的扫描每次都要遍历所有块
      // ——大文档里是两万三千个——而且每一帧滚动都做一遍，每多一轮还要再做一遍。
      // 滚动的卡顿感就是这么来的。
      var from = previewBlockAtOffset(top).index;
      var to = Math.min(blocks.length, previewBlockAtOffset(bottom).index + 1);
      if (from > to) { from = to; }

      var above = previewPrefix(from);
      var below = previewPrefix(blocks.length) - previewPrefix(to);
      var heldTop = view.scrollTop;
      dom.previewTop.style.height = above + 'px';
      dom.previewBottom.style.height = below + 'px';
      // 写入占位元素会改变内容高度，而内容刚变短时浏览器会钳制偏移量。
      // 记录它把窗格留在何处，这样随之而来的那次钳制（表现为滚动事件）就不会被解读为
      // 读者在移动窗格。只在确实是这次写入造成的钳制时才声明位置：
      // 无条件声明会吞掉下一次真正落到同一偏移量的滚动，
      // 一个窗格就此可能彻底停止跟随。
      if (view.scrollTop !== heldTop) {
        placedPreviewAt = Date.now();
        placedPreviewValue = view.scrollTop;
      }

      // 只有离开窗口的块会被拆除，因此一次普通滚动只会重建进出窗口的那两三个块。
      var wasFrom = previewDoc.from;
      var wasTo = previewDoc.to;
      if (wasTo > wasFrom) {
        for (var drop = wasFrom; drop < Math.min(wasTo, from); drop++) { undrawPreviewBlock(drop); }
        for (var drop2 = Math.max(wasFrom, to); drop2 < wasTo; drop2++) { undrawPreviewBlock(drop2); }
      }
      for (var draw = from; draw < to; draw++) { drawPreviewBlock(draw); }

      previewDoc.from = from;
      previewDoc.to = to;

      // 要等上面的绘制完成对已排版块的测量之后，再把读者放回原处：
      // 这些测量会移动它们下方的一切。
      restorePreviewAnchorLine(anchor);

      // 高度必须在窗口绘制*之后*读取，绝不能提前。绘制会测量它排版的块，而某个块
      // 实测比估算更高时，它下方的一切都会变高——因此绘制前读到的数值，等到面板
      // 下一次定位时已经不准了。正是这个过期数值让阅读窗格差一点到不了文档末尾：
      // 同步逻辑把它钳制到了滚动容器早已不存在的高度上。
      previewDoc.scrollHeight = dom.previewScroll.scrollHeight;
      // ……但正在输入字符时不这样做。在文档末尾输入会让视口下方的部分变长，而把面板
      // 钉在末尾会让阅读窗格每敲一次键就往下走一行。输入过程中保持不动的是上面那个
      // 锚定的行——那才是读者正在看的地方，而文档末尾仍然只差一次滚动。
      if (wasAtEnd && Date.now() >= editorTypingUntil) { pinPaneToEnd(view); }

      if (previewDoc.dirtyFrom >= dirtyBefore) { break; }
    }
  }

  /**
   * 阅读窗格顶部的源码位置：行号加上行内比例，取不到时返回 null。
   *
   * 从真正位于屏幕上的那些块的盒子读取，而不是从高度表读取：高度表对视口上方的块
   * 只是估算，用它取锚点会让面板在每次排版后都偏离原位几行——这正是两边一直无法
   * 稳定下来的原因。
   *
   * 用源码位置而不是像素偏移量，因为前者能经受重新渲染：块列表可能在下面发生变化，
   * 而同一个偏移量那时指向的就是文档中的另一个位置了。
   */
  function previewAnchorLine() {
    var view = dom.previewScroll;
    var paneTop = view.getBoundingClientRect().top;
    // *行*是从内容的顶部读取的，而不是滚动容器的上边缘：反方向的定位会把源码位置
    // 放在那个原点（`previewTopForLine` 会减去滚动容器自身的内边距），
    // 而 VS Code 的预览同步读写的是同一个偏移量 `scrollY`，两端都不含内边距。
    // 读写采用不同的原点，正是两个窗格相差半行的原因，表现为大纲在标题边界处停在
    // 上一节。
    var origin = paneTop + previewTopPadding();
    for (var i = previewDoc.from; i < previewDoc.to; i++) {
      var nodes = previewDoc.chunks[i];
      var element = nodes && nodes.length ? nodes[0] : null;
      if (!element || element.nodeType !== 1) { continue; }

      var rect = element.getBoundingClientRect();
      if (rect.bottom <= paneTop + 1) { continue; }

      var span = Math.max(1, previewDoc.spans[i] || 1);
      var into = rect.height > 0 ? Math.min(1, Math.max(0, (origin - rect.top) / rect.height)) : 0;
      return {
        line: (previewDoc.starts[i] || 0) + into * span,
        // 该源码位置此刻在内容中的位置。排版按这个数值的*变化量*修正滚动，
        // 因此读者在排版运行期间滚动过的内容仍保持滚过——强行恢复旧的绝对位置，
        // 正是让面板感觉卡住不动的原因。
        //
        // 这里用的是滚动坐标，从滚动容器自身的上边缘算起，*不是*从 `origin` 算起。
        // `restorePreviewAnchorLine` 会把该数值与 `previewTopPadding() + blockTop +
        // fraction` 相减，所以把内容内边距也带进来，会让每次排版都把面板往下推一个
        // 内边距：输入时阅读窗格就这样一按键一次地被推离自己的内容。
        at: view.scrollTop + (rect.top - paneTop) + into * rect.height,
      };
    }
    return null;
  }

  /** 把阅读窗格放回 `anchor`，即上面得到的源码位置。 */
  function restorePreviewAnchorLine(anchor) {
    if (!anchor) { return; }
    var line = Math.floor(anchor.line);
    var index = previewBlockForLine(line);
    if (index < 0) { return; }
    var span = previewDoc.spans[index] || 1;
    var into = line - (previewDoc.starts[index] || 0) + (anchor.line - line);
    var view = dom.previewScroll;
    var fraction = span > 0 ? Math.min(1, Math.max(0, into / span)) : 0;

    // 已绘制的块有真实的盒子可以瞄准；高度表只用于不在屏幕上的块，
    // 它们的高度仍是估算值。
    var nodes = previewDoc.chunks[index];
    var element = nodes && nodes.length ? nodes[0] : null;
    var wanted = null;
    if (element && element.nodeType === 1) {
      var rect = element.getBoundingClientRect();
      if (rect.height > 0) {
        wanted = view.scrollTop + (rect.top - view.getBoundingClientRect().top) + fraction * rect.height;
      }
    }
    if (wanted == null) {
      wanted = previewTopPadding() + previewBlockTop(index) + fraction * blockHeight(index);
    }

    // 只修正内容自身的移动，绝不修正读者自己的滚动：`anchor.at` 是锚定行在排版开始
    // 时所处的位置，`wanted` 是它现在的位置，两者之差就是实测高度在它下方增加或
    // 减少的量。
    var delta = wanted - (anchor.at == null ? wanted : anchor.at);
    if (Math.abs(delta) < 1) { return; }

    // 记作我们放置的位置：这次排版刚刚绘制并测量了该位置附近的块，
    // 因此它触发的滚动事件不应再排入一次排版。
    placedPreviewAt = Date.now();
    var max = Math.max(0, (previewDoc.scrollHeight || view.scrollHeight) - view.clientHeight);
    view.scrollTop = Math.min(max, Math.max(0, view.scrollTop + delta));
    placedPreviewValue = view.scrollTop;
  }

  /**
   * 包含源码行 `line` 的块下标，找不到时返回 -1。
   *
   * 块表是唯一了解视口未持有的那些行的地方：CodeMirror 的指南说得很直白——
   * 视口之外的位置不存在坐标，因为那里根本没有排版过。
   */
  function previewBlockForLine(line) {
    var starts = previewDoc.starts;
    if (!starts.length) { return -1; }
    // `starts` 是有序的，因此跳到远处标题的代价是一次二分查找，
    // 而不是遍历整张表——而且大纲随时都可能被点击。
    var low = 0;
    var high = starts.length - 1;
    while (low < high) {
      var mid = (low + high + 1) >> 1;
      if (starts[mid] <= line) { low = mid; } else { high = mid - 1; }
    }
    return starts[low] <= line ? low : -1;
  }

  /**
   * 包含 `offset` 的块，以及在该块内深入的程度。
   *
   * 在前缀表上做二分查找：它取代的遍历方式在有效期内开销很小，但只要它游标之前有
   * 高度发生变化就会悄悄出错——为了省下几微秒做这种交换并不值得。
   */
  function previewBlockAtOffset(offset) {
    var blocks = previewDoc.blocks;
    if (!blocks.length) { return { index: -1, into: 0 }; }

    // 调用方传入的是滚动位置，其中包含滚动容器的上内边距；
    // 而块表是从第一个块开始的。
    var y = offset - previewTopPadding();
    if (y < 0) { return { index: 0, into: y }; }

    var low = 0;
    var high = blocks.length - 1;
    while (low < high) {
      var mid = (low + high + 1) >> 1;
      if (previewPrefix(mid) <= y) { low = mid; } else { high = mid - 1; }
    }
    return { index: low, into: y - previewPrefix(low) };
  }

  /** 块 `index` 顶部在预览可滚动内容中的位置。 */
  function previewBlockTop(index) {
    return previewPrefix(index);
  }

  /**
   * 预览滚动容器的上内边距，单位为像素。
   *
   * 每个块都位于它下方，因此块在滚动容器中的位置等于其高度偏移量加上这个值。
   * 这里做了缓存——它只在样式表变化时改变，而这正是最初实现出错之处：
   * 块表从零开始，于是预览最终比编辑器低了一个内边距。
   */
  var previewTopPaddingPx = -1;
  function previewTopPadding() {
    if (previewTopPaddingPx < 0) {
      previewTopPaddingPx = parseFloat(getComputedStyle(dom.previewScroll).paddingTop) || 0;
    }
    return previewTopPaddingPx;
  }

  /**
   * 把预览滚动到包含源码行 `line` 的块，沿途把它绘制出来。
   *
   * 视口只能容纳一屏，因此几千行之下的标题还没有可供测量的元素——跳转必须经过
   * 块表，而不是经过 DOM。返回最终落到的块下标。
   */
  function previewScrollToLine(line) {
    var index = previewBlockForLine(line);
    if (index < 0) { return -1; }
    dom.previewScroll.scrollTop = previewTopPadding() + previewBlockTop(index);
    layoutPreview();
    return index;
  }

  /**
   * 绘制全部块，用于那些渲染页面而非模型的操作用途：打印和导出 PDF 都向 WebView2
   * 索取屏幕上的内容，而视口只能容纳一屏。
   */
  function drawAllPreviewBlocks() {
    for (var i = 0; i < previewDoc.blocks.length; i++) { drawPreviewBlock(i); }
    if (dom.previewTop) { dom.previewTop.style.height = '0px'; }
    if (dom.previewBottom) { dom.previewBottom.style.height = '0px'; }
  }

  /** 若块 `index` 尚不在 DOM 中，则把它绘制出来。 */
  function drawPreviewBlock(index) {
    if (previewDoc.chunks[index]) { return; }

    var nodes = blockChunk(previewDoc.blocks[index]);
    var host = dom.preview;

    // 块的来源行号就标在块自身上——与 VS Code 的 Markdown 预览给每个块打的标记
    // 相同（其 `code-line` 元素上的 `data-line`）。有了它，已渲染的块无需查表
    // 就能回答“你来自哪一行”，分栏视图的测试也正是读取它来比对两个窗格。
    if (nodes[0] && nodes[0].nodeType === 1) {
      nodes[0].setAttribute('data-line', String(previewDoc.starts[index] || 0));
      nodes[0].setAttribute('data-end-line', String(previewDoc.ends[index] || 0));
    }

    // 已绘制的块是连续的一段，因此插入点就在它的一端。把块插到别处会在错误的
    // 位置测量它——这一点很关键，因为分栏同步正是为了读取真实位置才去绘制要同步
    // 到的那个块。
    var before = dom.previewBottom || null;
    if (index < previewDoc.from) {
      for (var b = previewDoc.from; b < previewDoc.to; b++) {
        var first = previewDoc.chunks[b];
        if (first && first.length) { before = first[0]; break; }
      }
    }

    for (var i = 0; i < nodes.length; i++) { host.insertBefore(nodes[i], before); }
    previewDoc.chunks[index] = nodes;

    // 测量刚刚绘制的内容，使下一次排版依据真实高度而非估算值。
    // 这就是 CodeMirror 高度模型中“内容绘制后精确测量”的那一半。
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    if (first && first.nodeType === 1) {
      var box = first.getBoundingClientRect();
      var bottom = last && last.nodeType === 1 ? last.getBoundingClientRect().bottom : box.bottom;
      var measured = Math.round(Math.max(0, bottom - box.top));
      if (measured > 0 && measured !== previewDoc.heights[index]) {
        previewDoc.heights[index] = measured;
        // 实测值与估算值不同的块会移动它后面的一切：前缀表从该处起失效，
        // 并在下一次查找时重新向后扩展。
        markPreviewHeightDirty(index);
      }
    }
  }

  /** 从 DOM 中移除块 `index`；其高度转由占位元素承担。 */
  function undrawPreviewBlock(index) {
    var nodes = previewDoc.chunks[index];
    if (!nodes || !nodes.length) { return; }
    for (var i = 0; i < nodes.length; i++) { nodes[i].remove(); }
    previewDoc.chunks[index] = null;
  }

  var previewLayoutFrame = 0;

  /**
   * 编辑器的行高（像素），已缓存。
   *
   * `getComputedStyle` 不是一次简单查找——只要有任何样式被标记为脏，它就会强制
   * 重新计算样式，而分栏同步在每一帧滚动时都会去取它。它只在设置变化时改变，
   * 那些地方会调用 `forgetEditorLineHeight`。
   */
  var editorLineHeightPx = 0;
  function editorLineHeight() {
    if (!editorLineHeightPx) {
      editorLineHeightPx = parseFloat(getComputedStyle(dom.editor).lineHeight) || 28;
    }
    return editorLineHeightPx;
  }
  function forgetEditorLineHeight() { editorLineHeightPx = 0; editorTopPaddingPx = -1; }

  /** 编辑区在第一行之上留出的间距，单位为像素。 */
  var editorTopPaddingPx = -1;
  function editorTopPadding() {
    if (editorTopPaddingPx < 0) {
      editorTopPaddingPx = parseFloat(getComputedStyle(dom.editor).paddingTop) || 0;
    }
    return editorTopPaddingPx;
  }

  /** 清空已绘制的块，但保留撑起高度的占位元素。 */
  function clearPreview() {
    dom.preview.textContent = '';
    dom.preview.appendChild(dom.previewTop);
    dom.preview.appendChild(dom.previewBottom);
  }

  /**
   * 图片加载是唯一依赖原生宿主映射的预览功能，因此保留一个诊断开关。监听器挂在
   * 窗格上而不是每张图片上，这样增量重建新增的块也能被覆盖到——而 `load` 事件
   * 不冒泡，所以使用捕获阶段。
   */
  var previewDiagnosticsWired = false;
  function wirePreviewDiagnostics() {
    if (previewDiagnosticsWired || !diagnoseImages) { return; }
    previewDiagnosticsWired = true;
    dom.preview.addEventListener('load', function (event) {
      var image = event.target;
      if (!image || image.tagName !== 'IMG') { return; }
      hostCall('log', { line: 'img load ok ' + image.currentSrc + ' ' + image.naturalWidth + 'x' + image.naturalHeight });
    }, true);
    dom.preview.addEventListener('error', function (event) {
      var image = event.target;
      if (!image || image.tagName !== 'IMG') { return; }
      hostCall('log', { line: 'img load failed ' + image.currentSrc });
    }, true);
  }

  /**
   * 用新解析出的块列表更新预览。
   *
   * 标准的前缀/后缀差异比对：`head` 之前和 `oldEnd` 之后的内容逐字节相同，
   * 因此只拆除并重建两者之间的那一段。
   */
  function applyPreviewBlocks(tab, blocks, spans, starts, ends) {
    if (previewDoc.tabId !== tab.id) {
      clearPreview();
      previewDoc.tabId = tab.id;
      previewDoc.blocks = [];
      previewDoc.chunks = [];
      previewDoc.heights = [];
      previewDoc.dirtyFrom = 0;
      previewDoc.from = 0;
      previewDoc.to = 0;
    }

    // 块列表与屏幕上已有的完全一致时无需处理。比较的是对象标识，
    // 而块没有变化时解析会返回同一批字符串。
    var old = previewDoc.blocks;
    var same = old.length === blocks.length;
    for (var i = 0; same && i < blocks.length; i++) {
      if (old[i] !== blocks[i]) { same = false; }
    }
    if (same) { return; }

    // 读者的位置以源码位置而非像素偏移量传递，这样同一行会回到窗格顶部，而不是停在
    // 新估算值给出的那个偏移量处——列表两端未变化的部分则保留测得的原有高度。
    //
    // 保留它们很重要：高度表是滚动条和分栏同步瞄准的依据，整表丢弃会让每次编辑都
    // 重新估算读者上方的所有块，于是按键的那一刻滚动偏移量就会跳动几百像素——
    // 尽管读者眼前的那一行并没有动。
    var head = 0;
    while (head < previewDoc.blocks.length && head < blocks.length &&
           previewDoc.blocks[head] === blocks[head]) { head++; }
    var tail = 0;
    while (tail < previewDoc.blocks.length - head && tail < blocks.length - head &&
           previewDoc.blocks[previewDoc.blocks.length - 1 - tail] ===
             blocks[blocks.length - 1 - tail]) { tail++; }

    var heights = new Array(blocks.length);
    var kept;
    for (kept = 0; kept < head; kept++) { heights[kept] = previewDoc.heights[kept]; }
    for (kept = 0; kept < tail; kept++) {
      heights[blocks.length - 1 - kept] = previewDoc.heights[previewDoc.blocks.length - 1 - kept];
    }

    var anchor = previewAnchorLine();
    var heldTop = dom.previewScroll.scrollTop;
    var wasAtEnd = paneAtEnd(dom.previewScroll);
    clearPreview();
    previewDoc.blocks = blocks;
    previewDoc.spans = spans;
    previewDoc.starts = starts;
    previewDoc.ends = ends;
    previewDoc.heights = heights;
    previewDoc.chunks = [];
    // 第一个发生变化的块之前的内容高度都未改变，
    // 因此前缀表只需从那里开始重建。
    previewDoc.dirtyFrom = head;
    previewDoc.from = 0;
    previewDoc.to = 0;
    // 绘制、测量和还原锚定行都在这一轮内按此顺序完成。
    // 锚点以纯行号传入：这一轮不能“按差值校正”，因为它会用的差值是在重建之前读取
    // 的，而紧接着的定位又会绝对地设定位置。两者同时进行会互相拉扯——读者眼前的
    // 那一行纹丝不动，窗格却在每次按键时来回跳动几百像素。
    layoutPreview(anchor ? { line: anchor.line } : null, wasAtEnd);
    // 那一轮只能依据*估算值*为读者定位：重建丢弃了所有实测高度，而它瞄准的表对
    // 视口未触及的一切都只是估算。现在该位置附近的块已经绘制完成，同一个源码行就能
    // 实测并精确放回——没有这一步，阅读窗格每次按键都会挪一小步，下一次按键又朝
    // 反方向挪回来。
    // ……除非读者停在文档末尾：那个位置本身就是末尾，再把锚定行放回顶部会在下一次
    // 按键时把窗格拖离末尾——两者互相打架，窗格就在它们之间来回跳。
    if (anchor && !paneAtEnd(dom.previewScroll)) { placePreviewOnLine(anchor.line); }
    // 只有在重建确实移动了窗格时才声明位置，理由与编辑器那边相同：
    // 无条件声明会吞掉下一次真正滚到同一偏移量的滚动。
    if (dom.previewScroll.scrollTop !== heldTop) {
      placedPreviewAt = Date.now();
      placedPreviewValue = dom.previewScroll.scrollTop;
    }
  }

  function renderPreview(force) {
    var tab = activeTab();
    if (!tab) { return; }

    wirePreviewDiagnostics();
    var started = performance.now();

    // 源码模式下无需绘制任何预览：只记下它已过期，
    // 等到切回分栏 / 阅读模式时一次性补上。
    if (!force && document.documentElement.dataset.mode === 'edit') {
      previewStale = true;
      // 源码模式不绘制预览，因此过去只要编辑器停在该模式，标题列表就一直冻结——
      // 在这里输入的标题要等切回之后才出现在大纲里。这里只需要块结构，
      // 因此这次解析会跳过渲染器的行内部分。
      refreshOutlineHeadings(tab);
      renderOutline();
      return;
    }

    var result;
    try {
      result = Markdown.render(tab.text, {
        blocks: true,
        // 单个 Enter 同样是读者能看到的换行：两个窗格是对照着读的，
        // 若软换行被折叠成空格，同一段文字在两侧就会占不同的行数。
        breaks: true,
        resolveUrl: resolveUrl,
        highlight: function (code, lang) { return Highlight.render(code, lang); },
        math: function (tex, display) { return MathML.render(tex, display); },
      });
    } catch (error) {
      result = { html: '<p>渲染失败：' + esc(error.message) + '</p>', blocks: [], headings: [] };
    }

    var parsed = result.blocks || [];
    var safe = result.html;
    var html = [];
    var spans = [];
    var starts = [];
    var ends = [];

    // 渲染器会转义它接收到的一切，因此原始 HTML 只可能来自源码中的 `<`。没有 `<`
    // 时完全跳过安全过滤（一次完整解析加一次树遍历）；有 `<` 时按块执行，
    // 其开销便随实际重建的内容而变化。
    var hasRawHtml = tab.text.indexOf('<') >= 0;
    if (hasRawHtml) { safe = ''; }
    for (var i = 0; i < parsed.length; i++) {
      var piece = hasRawHtml ? sanitizeHtml(parsed[i].html) : parsed[i].html;
      html.push(piece);
      if (hasRawHtml) { safe += piece; }
      // 源码行数，用于尚未绘制的块的初次高度估算。
      spans.push(Math.max(1, (parsed[i].endLine || 0) - (parsed[i].line || 0)));
      starts.push(parsed[i].line || 0);
      ends.push(parsed[i].endLine || parsed[i].line || 0);
    }

    tab.headings = result.headings;
    tab.headingsText = tab.text;
    tab.renderedHtml = safe;
    // 超过这个大小后，预览将采用与编辑器相同的“跳过屏幕外内容”处理。
    dom.preview.classList.toggle('is-long', safe.length > 400000);

    var parsedAt = performance.now();
    applyPreviewBlocks(tab, html, spans, starts, ends);
    var paintedAt = performance.now();

    renderOutline();
    previewStale = false;

    // 预览处理是一按键所能触发的最昂贵操作，因此耗时较久时会指明慢在哪一半。
    // 这里只对长文档的第一段计时；其余部分在随后的帧中逐步铺开。
    var cost = Math.round(paintedAt - started);
    if (cost >= 40) {
      hostCall('log', {
        line: 'preview: ' + Math.round(parsedAt - started) + 'ms parse + ' +
          Math.round(paintedAt - parsedAt) + 'ms first paint = ' + cost + 'ms, ' +
          html.length + ' blocks',
      }).catch(function () {});
    }
  }

  // ---------------------------------------------------------------- 大纲

  /**
   * 只重新解析标题列表，不渲染文档。供那些没有预览可绘制、
   * 但仍需要实时大纲的路径使用。
   */
  function refreshOutlineHeadings(tab) {
    if (!tab) { return; }
    try {
      tab.headings = Markdown.render(tab.text, { headingsOnly: true }).headings;
      tab.headingsText = tab.text;
    } catch (error) {
      // 写到一半的文档可能让渲染器抛异常；在下一次解析成功之前，
      // 保留上一份列表比清空更好。
    }
  }

  /**
   * 标题列表的指纹，用于让大纲判断当前显示的行是否仍然正确。
   *
   * id 本身已包含层级和文本，且在文档内唯一，因此这个指纹是精确的。
   * 每敲一次键就重建几千行，曾是预览处理中第二昂贵的操作——
   * 标题列表与正文不同，只有标题变化时才会改变。
   */
  var outlineKey = null;
  function outlineKeyOf(headings) {
    var out = '';
    for (var i = 0; i < headings.length; i++) {
      out += headings[i].level + ':' + headings[i].id + '\u0000';
    }
    return out;
  }

  function renderOutline() {
    var tab = activeTab();

    if (!tab || !tab.headings || !tab.headings.length) {
      if (outlineKey !== '') {
        dom.outline.innerHTML = '<div class="empty-hint">这里会显示文档大纲<br>' +
          '<span style="font-size:11px">用 # 标题来组织内容</span></div>';
        dom.outline.scrollTop = 0;
        outlineKey = '';
      }
      return;
    }

    var key = outlineKeyOf(tab.headings);
    if (key === outlineKey && dom.outline.childElementCount) {
      // 与上次相同的行：只有“我在哪里”的标记可能移动了。
      refreshOutlineMarker();
      return;
    }
    outlineKey = key;

    // 重建可能会把读者甩回列表顶部，
    // 因此要把滚动位置带过去。
    var scroll = dom.outline.scrollTop;
    dom.outline.innerHTML = tab.headings.map(function (heading, index) {
      return '<button class="outline-item" data-level="' + Math.min(heading.level, 6) +
        '" data-index="' + index + '" title="' + esc(heading.text) + '">' + esc(heading.text) + '</button>';
    }).join('');
    dom.outline.scrollTop = scroll;

    // 重建替换了所有条目，标记也随之随旧元素一起消失，要等光标再次移动才恢复。
    // 这里在同一次绘制中把它补回，而不是留到下一帧：
    // 标记缺一帧就是一次闪烁，而这段代码每次渲染都会跑。
    refreshOutlineMarker();
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) { return CSS.escape(value); }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function editorLineOffset(lineIndex) {
    var lines = dom.editor.value.split('\n');
    var offset = 0;
    for (var i = 0; i < lineIndex && i < lines.length; i++) { offset += lines[i].length + 1; }
    return offset;
  }

  function scrollToHeading(index) {
    var tab = activeTab();
    if (!tab || !tab.headings || !tab.headings[index]) { return; }
    var heading = tab.headings[index];
    var mode = document.documentElement.dataset.mode;

    // 阅读模式只绘制预览，编辑器没有可移动的东西，应当滚入视野的就是渲染出的标题
    // ——而它的块必须先被绘制出来，才谈得上测量。
    if (mode === 'read') {
      previewScrollToLine(heading.line);
      // 点击时立即点亮，而不是等跳转落定。跳转是瞬时的，
      // 没有可供标记停留的移动过程。
      markOutline(outlineIndexForLine(heading.line));
      scrollPreviewToHeading(dom.preview.querySelector('#' + cssEscape(heading.id)), heading.line);
      return;
    }

    // 这里完全不碰预览，连查找标题所在的块也不做：分栏同步会随着编辑器的移动带着
    // 它走，这样只有一次动画而不是两次。事先把它滚到目标位置——过去为了让下面的
    // 查询能找到东西就是这么做的——会让它先跑到读者正在看的窗格前面，
    // 随后同步又把它拖回来。
    //
    // `keepLine` 是读者当前所看的位置（源码行）：把光标放到下面会围绕它重绘窗口，
    // 而代替上方各行的折叠段是按不折行文本估算高度的——于是内容会在这个被固定住的
    // 偏移量下发生移动。
    var keepLine = viewportTopLine();
    var position = editorLineOffset(heading.line);
    var held = dom.editorScroll.scrollTop;
    dom.editor.focus();
    // 夺回焦点会让窗格滚动到 Chromium 在顶部凭空造出的光标处：此前焦点属于大纲
    // 按钮，编辑器的选区也随之丢失（参见 `lastCaret`）。把窗格放回读者离开时的位置，
    // 跳转动画才会从那里开始——若从顶部开始，就成了一次跨越整篇文档的滑动，
    // 也就是过去点击大纲行的观感。
    if (dom.editorScroll.scrollTop !== held) { placePane(dom.editorScroll, held, 0, held); }

    // 把光标放到标题行上：这也会把该行拉进已绘制的窗口，
    // 从而让它的位置可以被测量。旧代码用行号乘以行高，因此只要它上方某个段落折到
    // 第二行，跳转就会偏移。
    dom.editor.setSelectionRange(position, position);

    // 重绘移动了内容；把原本位于顶部的那一行放回顶部，
    // 滑动才会从读者正在看的位置开始。否则一点击该行，窗格就会偏移几行。
    if (keepLine != null) {
      var restored = editorTopForLine(keepLine - 1);
      if (restored != null) { placePane(dom.editorScroll, restored, 0, editorScrollRange()); }
    }

    // 立刻点亮被点击的那一行——是读者点它的，应该在窗格移动过程中就亮着，
    // 而不是等落定之后。这个保持（hold）机制避免移动过程把标记拖过中间每一节。
    markOutline(outlineIndexForLine(heading.line));
    outlineQuiet = true;
    glideToHeading(heading.line, function () {
      // 更新的点击已经接管了标记；把保持状态让给它。
      if (lineIndexOfOffset(dom.editor.selectionStart) !== heading.line) { return; }
      outlineQuiet = false;
    });
    syncPreviewFromEditor();
  }

  /**
   * 滚动预览，让渲染出的标题停在其顶部附近。
   *
   * 以滚动容器为基准测量，而不是交给 scrollIntoView：后者会逐级向上遍历每一个可
   * 滚动祖先，而在阅读模式下，它选中的往往不是需要移动的那个窗格。
   */
  function scrollPreviewToHeading(target, line) {
    if (!target) { return; }
    var view = dom.previewScroll;
    // 标题被放置在映射给源码行的位置：窗格*内容*的顶部，也就是距边缘一个自身
    // 内边距处。这一约定与 `previewTopForLine`/`editorTopForLine` 以及那些回答
    // “这是哪一节”的扫描共用，因此标记与定位不会互相矛盾——对于文档的第一行，
    // 它落在 0，即文档顶部，标题上方仍能看到内边距。
    var margin = previewTopPadding();
    var last = null;

    /*
     * 一次跳转，不是动画——这是 VS Code 预览采用的形式（`scrollToRevealSourceLine`
     * 中不带动画的 `window.scroll`）——只要仍在前进就重复执行。
     *
     * 之所以不能一次定位到位：高度表视口尚未触及的每个块都只是*估算*，因此第一次
     * 落点会因估算误差而偏短，而绘制它下方的块又会再次移动目标。每一轮都会测量更多
     * 中间内容，一旦不再前进循环立即停止。反过来，若拿这张表去校正一个*平滑*动画，
     * 跳转会停在半路——读者请求的标题永远到不了顶部，阅读模式下点击大纲就是如此。
     */
    for (var pass = 0; pass < 5; pass++) {
      var offset = target.getBoundingClientRect().top - view.getBoundingClientRect().top;
      view.scrollTop = Math.max(0, view.scrollTop + offset - margin);
      // 在落点附近绘制并测量。这里传入锚点，使这一轮不会把窗格拉回它开始的
      // 位置——那个行为是为读者自己移动的情况准备的。
      layoutPreview({ line: line });

      var after = target.getBoundingClientRect().top - view.getBoundingClientRect().top;
      if (Math.abs(after - margin) <= 2) { break; }
      var next = Math.max(0, view.scrollTop + after - margin);
      if (last != null && Math.abs(next - last) < 1) { break; }
      last = next;
    }

    // 这是我们放置的，不是读者滚动的：由此产生的滚动事件不能被同步逻辑或大纲
    // 解读为读者在移动窗格。
    placedPreviewValue = view.scrollTop;
    syncEditorFromPreview();
  }

  /**
   * 把阅读窗格放到源码位置 `line`，并测量两次。
   *
   * 用于窗格刚在宽度变化后重新排版、需要还原读者位置的情形——视图模式切换时窗格
   * 宽度会变，读者上方每一处折行的高度也随之改变。第二轮的缘由与这里其他地方相同：
   * 在目标附近的块被绘制之前，目标下方的高度表只是估算。
   */
  function placePreviewOnLine(line) {
    var first = previewTopForLine(line);
    if (first == null) { return; }
    placePane(dom.previewScroll, first, 0, previewScrollRange());
    layoutPreview({ line: line });
    var exact = previewTopForLine(line);
    if (exact != null) { placePane(dom.previewScroll, exact, 0, previewScrollRange()); }
  }

  /**
   * 把编辑器滚动到光标所在行，然后消除剩余的偏差。
   *
   * 第一个目标位置是精确的——caretMetrics() 读取的是真实行——但编辑器只绘制视口
   * 周围的窗口，并用高度估算的占位元素代替折叠段，因此等到视图到位时，该行已经稍微
   * 移动了。
   *
   * 这次校正等滚动停止后再做，而不是靠定时器触发：固定延时无法预知长距离跳转
   * 需要多久，而在飞行途中触发会打断动画，跳转看上去就很毛糙。
   *
   * 标题被放到窗格内容的顶部——距边缘一个内边距，与 `editorTopForLine` 和标记自身
   * 的扫描使用同一个原点。若跳转后标题上方还留着上下文，读者就仍停留在上一节，
   * 高亮也跟着停在那里（点击“外观与个性化”，却是“导出”亮起）；而贴到边缘又会把
   * 那点内边距滚掉，文档第一行便挤在工具栏下方，而不是停在文件顶部。
   */
  function glideToHeading(line, done) {
    // 与预览、以及 `editorTopForLine` 使用同一个原点：标题落在窗格*内容*的顶部，
    // 距边缘一个内边距。贴到边缘会把这点内边距滚掉——对文档第一行而言，
    // 那就是“文件顶部”与“标题挤在工具栏下方”的区别。
    var margin = editorTopPadding();
    dom.editorScroll.scrollTo({ top: Math.max(0, caretMetrics().top - margin), behavior: 'smooth' });

    var settle = 0;
    var onScroll = function () {
      clearTimeout(settle);
      settle = setTimeout(function () {
        dom.editorScroll.removeEventListener('scroll', onScroll);
        if (done) { done(); }
        // 若光标在滑动过程中已经移走，就不要动视图。
        if (lineIndexOfOffset(dom.editor.selectionStart) !== line) { return; }
        var exact = Math.max(0, caretMetrics().top - margin);
        if (Math.abs(exact - dom.editorScroll.scrollTop) > 2) {
          dom.editorScroll.scrollTo({ top: exact, behavior: 'smooth' });
        }
        // 等这一侧彻底停下后再放置另一侧窗格：滑动过程中的滚动事件会驱动同步，
        // 但上面的最终校正可能什么都不做（本来就在那里），
        // 于是不会再产生滚动事件把预览带上。
        syncPreviewFromEditor();
      }, 140);
    };

    dom.editorScroll.addEventListener('scroll', onScroll);
    onScroll();   // 跳到当前所在的位置不会触发滚动事件
  }

  // ------------------------------------------------------------------- 标签

  function makeTab(options) {
    var tab = {
      id: state.nextId++,
      path: options.path || '',
      name: options.name || '未命名',
      text: options.text == null ? '' : options.text,
      savedText: options.text == null ? '' : options.text,
      dirty: false,
      encoding: options.encoding || 'utf-8',
      selStart: 0,
      selEnd: 0,
      scrollTop: 0,
      headings: [],
      // 上面那份标题列表所依据的文本。大纲会把从实时文本读到的光标行与那些标题行
      // 相比较，只有在这里的文本与 `text` 一致时，两者才处于同一坐标系。
      headingsText: null,
      renderedHtml: '',
      history: [],
      historyIndex: -1,
      historyTime: 0,
      // 在这里声明，而不是第一次使用时再添加：给一个对象新增它原本没有的属性会
      // 改变其 HiddenClass，之后每次属性读取都会错过上一个形状预热好的内联缓存。
      // V8 关于快速属性的建议就是：对象从一开始就应具备完整的形状。
      diskMissing: false,
      shown: false,
    };
    tab.history = [{ text: tab.text, selStart: 0, selEnd: 0 }];
    tab.historyIndex = 0;
    state.tabs.push(tab);
    return tab;
  }

  function tabTitle(tab) {
    return tab.path ? basename(tab.path) : tab.name;
  }

  /** 标签条显示的内容：在那个宽度下，".md" 后缀只是噪声。 */
  function tabLabel(tab) {
    return tabTitle(tab).replace(/\.md$/i, '');
  }

  function renderTabs() {
    // 与各面板同理：标签条会频繁重建，而重建过去会把滚动到后面的标签行拉回第一个。
    var scroll = dom.tabs.scrollLeft;

    // 在已打开的笔记之间分配标签条的宽度：上限较宽时能容下几个长文件名才开始滚动，
    // 因此随着标签增加而上限下降，并停在一个仍能显示省略号的宽度。新建标签按钮位于
    // 标签条之外，因此不再占用它的一份宽度。
    var share = dom.tabs.clientWidth / Math.max(1, state.tabs.length);
    dom.tabs.style.setProperty('--tab-max',
      Math.max(138, Math.min(330, Math.floor(share) - 4)) + 'px');

    dom.tabs.innerHTML = state.tabs.map(function (tab) {
      return '<div class="tab' + (tab.id === state.activeId ? ' is-active' : '') + '" data-id="' + tab.id +
        '" title="' + esc(tab.path || tabTitle(tab)) + '">' +
        (tab.dirty ? '<span class="dot"></span>' : '') +
        '<span class="label">' + esc(tabLabel(tab)) + '</span>' +
        '<button class="close" data-close="' + tab.id + '" title="关闭">' +
        '<svg class="icon icon-sm"><use href="#i-close"/></svg></button></div>';
    }).join('');
    dom.tabs.scrollLeft = scroll;

    // 切换到超出右边缘的标签时，它过去会停在屏幕之外，
    // 完全没有迹象表明当前激活的是哪一个笔记。
    if (state.activeId !== lastActiveTabId) {
      lastActiveTabId = state.activeId;
      var active = dom.tabs.querySelector('.tab.is-active');
      if (active) {
        var left = active.offsetLeft;
        var right = left + active.offsetWidth;
        if (left < dom.tabs.scrollLeft) { dom.tabs.scrollLeft = Math.max(0, left - 6); }
        else if (right > dom.tabs.scrollLeft + dom.tabs.clientWidth) {
          dom.tabs.scrollLeft = right - dom.tabs.clientWidth + 6;
        }
      }
    }

    rememberSession();
    syncWatchList();
  }

  var lastActiveTabId = 0;

  /**
   * 记住已打开的文件，以便下次启动时恢复。会话仍在恢复期间不会写入任何内容：
   * 否则会把这半份列表覆盖到完整的列表上。
   */
  function rememberSession() {
    if (!state.config || state.restoring) { return; }
    var paths = state.tabs.filter(function (tab) { return !!tab.path; })
      .map(function (tab) { return tab.path; });
    var active = activeTab();
    state.config.session = paths;
    state.config.sessionActive = active && active.path ? active.path : '';
    saveConfig();
  }

  /** 告知宿主应当监视哪些文件的外部改动。 */
  function syncWatchList() {
    var paths = state.tabs.filter(function (tab) { return !!tab.path; })
      .map(function (tab) { return tab.path; });
    var fingerprint = paths.join('\u0000');
    if (fingerprint === state.watchedPaths) { return; }
    state.watchedPaths = fingerprint;
    hostCall('watch', { paths: paths }).catch(function () {});
  }

  async function restoreSession() {
    var paths = (state.config.session || []).filter(function (path) { return !!path; });
    if (!paths.length) { return false; }

    state.restoring = true;
    try {
      // 恢复过程过去每收到一个标签就激活它，于是对并不显示在屏幕上的文档做了完整
      // 渲染——解析、语法高亮、预览排版——几个普通笔记就累积出数秒的启动时间。
      // 后台标签只需要文本：编辑器和预览在该标签首次显示时才构建，
      // 与任何一次标签切换相同。
      for (var i = 0; i < paths.length; i++) {
        await openPath(paths[i], true);
      }

      var active = String(state.config.sessionActive || '').toLowerCase();
      var tab = active && state.tabs.find(function (item) {
        return item.path && item.path.toLowerCase() === active;
      });
      var target = tab || state.tabs[state.tabs.length - 1];
      if (target) { activateTab(target.id); }
    } finally {
      state.restoring = false;
    }
    return state.tabs.some(function (tab) { return !!tab.path; });
  }

  /**
   * 磁盘上的文件已不再是编辑器持有的内容。没有改动的标签直接重新加载；
   * 有改动的会询问用户，因为无论选哪一项都会丢弃一部分工作。
   */
  async function onExternalChange(path, removed) {
    var tab = state.tabs.find(function (item) {
      return item.path && item.path.toLowerCase() === String(path).toLowerCase();
    });
    if (!tab) { return; }

    if (removed) {
      tab.diskMissing = true;
      if (!tab.dirty) { toast(basename(path) + ' 已在磁盘上被删除', true); }
      return;
    }

    var data = await hostCall('openPath', { path: path }).catch(function () { return null; });
    if (!data || data.error) { return; }
    tab.diskMissing = false;

    // 编辑器自身的保存也会走到这里；那不属于外部改动。
    if (data.text === tab.text || data.text === tab.savedText) { return; }

    if (!tab.dirty) {
      applyExternalText(tab, data.text, '已重新载入磁盘上的最新版本');
      return;
    }

    var choice = await showDialog({
      title: '文件已被其他程序修改',
      message: '「' + tabTitle(tab) + '」在磁盘上已经改变，而这里还有未保存的修改。',
      buttons: [
        { label: '保留我的修改', value: 'keep' },
        { label: '载入磁盘版本', value: 'reload', primary: true },
      ],
    });

    if (choice.value === 'reload') {
      applyExternalText(tab, data.text, '已载入磁盘版本');
    } else {
      // 保留编辑内容，但把磁盘上的新内容作为基线，
      // 这样之后保存时是一次明确的覆盖，而不是悄悄覆盖。
      tab.savedText = data.text;
      toast('已保留这里的修改，保存时会覆盖磁盘版本');
    }
  }

  function applyExternalText(tab, text, message) {
    tab.text = text;
    tab.savedText = text;
    tab.dirty = false;
    tab.history = [{ text: text, selStart: 0, selEnd: 0 }];
    tab.historyIndex = 0;

    if (activeTab() === tab) {
      dom.editor.value = text;
      renderHighlightNow();
      renderPreview();
      updateStatusBar();
    }
    renderTabs();
    updateWindowTitle();
    if (message) { toast(message); }
  }

  function persistTabView(tab) {
    if (!tab) { return; }
    tab.selStart = dom.editor.selectionStart;
    tab.selEnd = dom.editor.selectionEnd;
    tab.scrollTop = dom.editorScroll.scrollTop;
  }

  function activateTab(id, skipSave) {
    var previous = activeTab();
    if (!skipSave && previous && previous.id !== id) { persistTabView(previous); }

    // 标签换入过程中排版一直在变；在稳定之前忽略滚动事件，
    // 可以避免它们把错误的位置喂给同步逻辑。
    activating = true;

    state.activeId = id;
    var tab = activeTab();
    if (!tab) { return; }

    dom.editor.value = tab.text;

    state.find.matches = [];
    state.find.index = -1;
    state.find.byLine = new Map();

    renderTabs();
    renderHighlightNow();
    // 预览解析相对资源路径之前必须先知道文档所在目录，
    // 因此首次绘制要等这次往返完成。
    syncDocDirectory(tab).then(function () {
      renderPreview();
      // 等两个窗格都有最终高度后再恢复视口。设置选区会把光标滚入视野，
      // 因此滚动偏移量必须晚一帧应用，否则会立刻被覆盖。
      requestAnimationFrame(function () {
        dom.editor.setSelectionRange(tab.selStart || 0, tab.selEnd || 0);

        requestAnimationFrame(function () {
          if (activeTab() !== tab) { return; }

          var top = tab.shown ? (tab.scrollTop || 0) : 0;
          var editorMax = dom.editorScroll.scrollHeight - dom.editorScroll.clientHeight;
          var previewMax = dom.previewScroll.scrollHeight - dom.previewScroll.clientHeight;
          var previewTop = editorMax > 0 && previewMax > 0 ? (top / editorMax) * previewMax : 0;

          // 在这里聚焦而不是启动时：聚焦会把光标滚入视野，
          // 若在恢复视口之前就做，文档会一闪而滚到末尾。
          dom.editor.focus();
          dom.editorScroll.scrollTop = top;
          dom.previewScroll.scrollTop = previewTop;
          tab.shown = true;

          // 还原选区会在*下一次*排版时把光标滚入视野，因此等它稳定后再固化一次
          // 偏移量——否则切回一个你曾滚动过的标签时会跳到光标处。
          setTimeout(function () {
            if (activeTab() !== tab) { return; }
            dom.editorScroll.scrollTop = top;
            dom.previewScroll.scrollTop = previewTop;
            activating = false;
          }, 0);
        });
      });
    });

    updateStatusBar();
    updateWindowTitle();
  }

  function syncDocDirectory(tab) {
    return hostCall('setDocDirectory', { path: tab && tab.path ? tab.path : '' })
      .catch(function () { /* 相对资源只是暂时无法解析，无需处理 */ });
  }

  function newTab() {
    var tab = makeTab({ text: '' });
    activateTab(tab.id);
    dom.editor.focus();
  }

  function closeTab(id) {
    var tab = state.tabs.find(function (item) { return item.id === id; });
    if (!tab) { return; }

    if (!tab.dirty) { dropTab(id); return; }

    showDialog({
      title: '未保存的修改',
      message: '「' + tabTitle(tab) + '」有未保存的修改。',
      buttons: saveChoices('关闭'),
    }).then(function (choice) {
      if (choice.value === 'cancel') { return; }
      if (choice.value === 'discard') { dropTab(id); return; }
      saveTabForClose(tab).then(function (saved) { if (saved) { dropTab(id); } });
    });
  }

  function dropTab(id) {
    var index = state.tabs.findIndex(function (tab) { return tab.id === id; });
    if (index < 0) { return; }

    state.tabs.splice(index, 1);

    if (!state.tabs.length) {
      // 关闭最后一个标签后窗口将无内容可显示；
      // 一份空文档就是此时的落点状态。
      var fresh = makeTab({ text: '' });
      activateTab(fresh.id);
      return;
    }

    if (state.activeId === id) {
      var next = state.tabs[Math.min(index, state.tabs.length - 1)];
      activateTab(next.id, true);
    } else {
      renderTabs();
    }
  }

  var lastWindowTitle = '';

  function updateWindowTitle() {
    var tab = activeTab();
    var text = (tab && tab.dirty ? '• ' : '') + (tab ? tabTitle(tab) : 'cNote') + ' — cNote';
    // 每次按键都会调用；只有确实发生变化时才与宿主通信。
    if (text === lastWindowTitle) { return; }
    lastWindowTitle = text;
    hostCall('title', { text: text }).catch(function () {});
  }

  // ------------------------------------------------------------ 编辑历史

  function snapshot(tab, force) {
    var now = Date.now();
    var entry = { text: tab.text, selStart: dom.editor.selectionStart, selEnd: dom.editor.selectionEnd };

    if (!force && tab.historyIndex > 0 && now - tab.historyTime < 700) {
      tab.history[tab.historyIndex] = entry;
    } else {
      tab.history = tab.history.slice(0, tab.historyIndex + 1);
      tab.history.push(entry);
      // 撤销栈既要按步数限制，也要按内存限制：否则大文档的 400 份完整副本会占用
      // 数百兆字节。
      var limit = Math.max(20, Math.min(400, Math.floor(4194304 / Math.max(1, tab.text.length))));
      while (tab.history.length > limit) { tab.history.shift(); }
      tab.historyIndex = tab.history.length - 1;
    }
    tab.historyTime = now;
  }

  var suppressInput = false;
  var composing = false;

  function restoreHistory(tab, entry) {
    tab.text = entry.text;
    dom.editor.value = entry.text;
    suppressInput = true;
    dom.editor.setSelectionRange(entry.selStart, entry.selEnd);
    suppressInput = false;
    renderHighlightNow();
    schedulePreview();
    updateStatusBar();
    revealCaret();
  }

  function undo() {
    var tab = activeTab();
    if (!tab || tab.historyIndex <= 0) { return; }
    tab.historyIndex--;
    tab.historyTime = 0;
    restoreHistory(tab, tab.history[tab.historyIndex]);
    markDirty(tab);
  }

  function redo() {
    var tab = activeTab();
    if (!tab || tab.historyIndex >= tab.history.length - 1) { return; }
    tab.historyIndex++;
    tab.historyTime = 0;
    restoreHistory(tab, tab.history[tab.historyIndex]);
    markDirty(tab);
  }

  function markDirty(tab) {
    var wasDirty = tab.dirty;
    tab.dirty = tab.text !== tab.savedText;
    if (tab.dirty !== wasDirty) { updateTabDirtyMark(tab); }
    updateWindowTitle();
    updateStatusBar();
  }

  /**
   * 只重绘“未保存”小圆点。每次输入都重建整条标签栏还会重置它的横向滚动，
   * 于是标签一多，输入时列表就会猛地弹回最左边。
   */
  function updateTabDirtyMark(tab) {
    var node = dom.tabs.querySelector('.tab[data-id="' + tab.id + '"]');
    if (!node) { renderTabs(); return; }

    var dot = node.querySelector('.dot');
    if (tab.dirty && !dot) {
      var mark = document.createElement('span');
      mark.className = 'dot';
      node.insertBefore(mark, node.firstChild);
    } else if (!tab.dirty && dot) {
      dot.remove();
    }
  }

  // ---------------------------------------------------------- 编辑命令

  function commitEdit(selectionStart, selectionEnd, force) {
    var tab = activeTab();
    if (!tab) { return; }
    tab.text = dom.editor.value;
    snapshot(tab, force);
    markDirty(tab);
    renderHighlightNow();
    schedulePreview();
    updateStatusBar();

    if (selectionStart != null) {
      dom.editor.setSelectionRange(selectionStart, selectionEnd == null ? selectionStart : selectionEnd);
    }
    revealCaret();
    typewriterFollow();
    scheduleAutoSave();
  }

  function selectedLineRange() {
    var value = dom.editor.value;
    var start = value.lastIndexOf('\n', dom.editor.selectionStart - 1) + 1;
    var end = value.indexOf('\n', dom.editor.selectionEnd);
    if (end < 0) { end = value.length; }
    return { start: start, end: end };
  }

  function wrapSelection(before, after, placeholder) {
    var start = dom.editor.selectionStart;
    var end = dom.editor.selectionEnd;
    var value = dom.editor.value;
    var selected = value.slice(start, end);
    var inner = selected || placeholder || '';

    if (selected &&
        value.slice(start - before.length, start) === before &&
        value.slice(end, end + after.length) === after) {
      dom.editor.setRangeText(selected, start - before.length, end + after.length, 'preserve');
      commitEdit(start - before.length, end - before.length, true);
      return;
    }

    dom.editor.setRangeText(before + inner + after, start, end, 'preserve');
    var caret = start + before.length;
    commitEdit(caret, caret + inner.length, true);
  }

  /**
   * 在单独的行上插入块级片段（表格、代码围栏、分隔线、公式）。光标所在行会保留，
   * 块插在它后面，因此从行中间插入不再把该行切成两半。
   */
  function insertBlock(text) {
    var value = dom.editor.value;
    var start = value.lastIndexOf('\n', dom.editor.selectionStart - 1) + 1;
    var end = value.indexOf('\n', dom.editor.selectionEnd);
    if (end < 0) { end = value.length; }

    var line = value.slice(start, end);
    // 空行（或空文档）由这个块自身消费掉。
    var replacement = line.trim() ? line + '\n\n' + text : text;

    dom.editor.setRangeText(replacement, start, end, 'preserve');
    var caret = start + replacement.length;
    commitEdit(caret, caret, true);
  }

  function toggleHeading(level) {
    var range = selectedLineRange();
    var lines = dom.editor.value.slice(range.start, range.end).split('\n');
    var hashes = new Array(level + 1).join('#');
    var already = lines.every(function (line) {
      return new RegExp('^\\s*' + hashes + '\\s').test(line);
    });

    var result = lines.map(function (line) {
      var stripped = line.replace(/^\s*#{1,6}\s+/, '');
      return already ? stripped : hashes + ' ' + stripped;
    }).join('\n');

    dom.editor.setRangeText(result, range.start, range.end, 'preserve');
    commitEdit(range.start, range.start + result.length, true);
  }

  function togglePrefix(kind) {
    var range = selectedLineRange();
    var lines = dom.editor.value.slice(range.start, range.end).split('\n');

    var matchers = {
      ul: /^\s*[-*+]\s+(?!\[)/,
      ol: /^\s*\d{1,9}[.)]\s+/,
      task: /^\s*[-*+]\s+\[[ xX]\]\s+/,
      quote: /^\s*>\s?/,
    };
    var allHave = lines.every(function (line) { return matchers[kind].test(line); });
    var index = 0;

    var result = lines.map(function (line) {
      var cleaned = line
        .replace(matchers.task, '')
        .replace(matchers.ul, '')
        .replace(matchers.ol, '')
        .replace(matchers.quote, '');
      if (allHave || !cleaned.trim()) { return cleaned; }
      index++;
      if (kind === 'ul') { return '- ' + cleaned; }
      if (kind === 'ol') { return index + '. ' + cleaned; }
      if (kind === 'task') { return '- [ ] ' + cleaned; }
      return '> ' + cleaned;
    }).join('\n');

    dom.editor.setRangeText(result, range.start, range.end, 'preserve');
    commitEdit(range.start, range.start + result.length, true);
  }

  function indentSelection(outdent) {
    var range = selectedLineRange();
    var result = dom.editor.value.slice(range.start, range.end).split('\n').map(function (line) {
      if (outdent) { return line.replace(/^ {1,4}/, '').replace(/^\t/, ''); }
      return '  ' + line;
    }).join('\n');
    dom.editor.setRangeText(result, range.start, range.end, 'preserve');
    commitEdit(range.start, range.start + result.length, true);
  }

  /**
   * 插入粘贴或拖入的纯文本。
   *
   * 走编辑区自身的文本模型，而不用 `execCommand('insertText')`：浏览器会把多行
   * 字符串插入为块级元素和 `<br>` 元素，而 `textContent`——在应用其余部分看来就是
   * 文档本身——完全看不到这些，于是每次粘贴的换行都丢失了，各行被挤进同一个段落
   * （或者前面带 `#` 时，被并成一个标题）。
   */
  function insertPlainText(text) {
    var value = String(text).replace(/\r\n?/g, '\n');
    var start = dom.editor.selectionStart;
    var end = dom.editor.selectionEnd;
    dom.editor.setRangeText(value, start, end, 'end');
    commitEdit(start + value.length, start + value.length, true);
  }

  // ------------------------------------------------- 代码块缩进
  //
  // 围栏代码采用编辑器行为而非散文行为：Enter 保持该行的缩进（并在 `{`、`(` 或 `[`
  // 之后增加一级），Tab 插入代码尺寸的缩进（四个空格）而不是把整行 markdown 缩进
  // 两个空格，Shift+Tab 则退回一级。

  var CODE_INDENT = '    ';

  function lineIndexAt(text, position) {
    // 装饰数据里维护了行首索引；用它即可，
    // 不必在每次 Tab / Enter 时从文档开头数换行符。
    if (decoration.text === text && decoration.starts) { return lineIndexOfOffset(position); }

    var index = 0;
    for (var i = 0; i < position && i < text.length; i++) {
      if (text.charCodeAt(i) === 10) { index++; }
    }
    return index;
  }

  /** 光标所在行位于一对代码围栏之间时为真。 */
  function insideCodeFence() {
    var value = dom.editor.value;
    // 廉价的提前返回：大多数 Tab 都是在根本没有围栏的文档里按下的。
    if (value.indexOf('```') < 0 && value.indexOf('~~~') < 0) { return false; }
    var lines = value.split('\n');
    var index = lineIndexAt(value, dom.editor.selectionStart);
    var inside = false;
    var marker = '';

    for (var i = 0; i < index; i++) {
      var match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
      if (!match) { continue; }
      if (!inside) {
        inside = true;
        marker = match[1].charAt(0);
      } else if (match[1].charAt(0) === marker && !match[2].trim()) {
        inside = false;
        marker = '';
      }
    }
    return inside;
  }

  /**
   * 在围栏内部按下 Enter。光标不在代码块中时返回 false，
   * 好让列表续行逻辑仍有机会处理。
   */
  function continueCodeIndent() {
    if (!insideCodeFence()) { return false; }

    var value = dom.editor.value;
    var start = dom.editor.selectionStart;
    var end = dom.editor.selectionEnd;
    var lineStart = value.lastIndexOf('\n', start - 1) + 1;
    var before = value.slice(lineStart, start);
    var indent = /^[ \t]*/.exec(before)[0];
    var next = value.charAt(end);

    var openers = { '{': '}', '(': ')', '[': ']' };
    var head = before.trim();
    var closer = openers[head.slice(-1)] || '';
    // 行尾的冒号同样会开启一个块（python、yaml），
    // 但 URL 协议前缀或连续两个冒号不会。
    if (!closer && head.slice(-1) === ':' && head.slice(-2) !== '::' && head.indexOf('//') < 0) {
      closer = '\u0000';
    }

    // 在一对匹配的符号之间按 Enter：把闭合符号推到单独一行。
    if (closer && closer !== '\u0000' && next === closer) {
      var insert = '\n' + indent + CODE_INDENT + '\n' + indent;
      dom.editor.setRangeText(insert, start, end, 'end');
      var caret = start + 1 + indent.length + CODE_INDENT.length;
      commitEdit(caret, caret, true);
      return true;
    }

    // 带缩进的空行会退出一级，而不是再加一级。
    var hasNextLine = value.charAt(end) === '\n';
    if (!before.trim() && hasNextLine && indent.length >= CODE_INDENT.length) {
      var outer = indent.slice(0, indent.length - CODE_INDENT.length);
      dom.editor.setRangeText(outer, lineStart, start, 'end');
      var outCaret = lineStart + outer.length;
      commitEdit(outCaret, outCaret, true);
      return true;
    }

    var deeper = closer ? indent + CODE_INDENT : indent;
    dom.editor.setRangeText('\n' + deeper, start, end, 'end');
    var nextCaret = start + 1 + deeper.length;
    commitEdit(nextCaret, nextCaret, true);
    return true;
  }

  /** 围栏内的 Tab / Shift+Tab：以代码尺寸为单位缩进。 */
  function indentCode(outdent) {
    var value = dom.editor.value;
    var start = dom.editor.selectionStart;
    var end = dom.editor.selectionEnd;
    var multiline = value.slice(start, end).indexOf('\n') >= 0;

    if (multiline) {
      var lineStart = value.lastIndexOf('\n', start - 1) + 1;
      var lineEnd = value.indexOf('\n', end);
      if (lineEnd < 0) { lineEnd = value.length; }
      var result = value.slice(lineStart, lineEnd).split('\n').map(function (line) {
        if (outdent) {
          return line.slice(0, CODE_INDENT.length) === CODE_INDENT
            ? line.slice(CODE_INDENT.length)
            : line.replace(/^[ \t]{1,4}/, '');
        }
        return CODE_INDENT + line;
      }).join('\n');
      dom.editor.setRangeText(result, lineStart, lineEnd, 'preserve');
      commitEdit(lineStart, lineStart + result.length, true);
      return;
    }

    if (!outdent) {
      dom.editor.setRangeText(CODE_INDENT, start, end, 'end');
      commitEdit(start + CODE_INDENT.length, start + CODE_INDENT.length, true);
      return;
    }

    var lineStart2 = value.lastIndexOf('\n', start - 1) + 1;
    var before = value.slice(lineStart2, start);
    var spaces = /[ \t]*$/.exec(before)[0];
    var cut = Math.min(CODE_INDENT.length, spaces.length);
    if (cut) {
      dom.editor.setRangeText('', start - cut, start, 'end');
      commitEdit(start - cut, start - cut, true);
      return;
    }

    var lineEnd2 = value.indexOf('\n', start);
    if (lineEnd2 < 0) { lineEnd2 = value.length; }
    var lead = /^[ \t]*/.exec(value.slice(lineStart2, lineEnd2))[0];
    var head = Math.min(CODE_INDENT.length, lead.length);
    if (head) {
      dom.editor.setRangeText('', lineStart2, lineStart2 + head, 'end');
      var caret = Math.max(lineStart2, start - head);
      commitEdit(caret, caret, true);
    }
  }

  // ------------------------------------------------------------- 光标工具

  /**
   * 光标所在行在滚动容器中的位置（滚动坐标）。
   * 从高亮层中真实的 DOM 行测量，因此折行的行（高度并非一个行盒）
   * 不会让位置失准。
   */
  function caretMetrics() {
    var text = dom.editor.value;
    var position = dom.editor.selectionStart;
    var lineIndex = lineIndexOfOffset(position);

    var lineHeight = editorLineHeight();
    var row = lineNode(lineIndex);
    if (!row) {
      // 要么这一层比换行符慢了一帧，要么该行位于折叠文本块中——
      // 两种情况都按行高估算。
      return { top: 30 + lineIndex * lineHeight, height: lineHeight };
    }

    var scrollerRect = dom.editorScroll.getBoundingClientRect();
    var rowRect = row.getBoundingClientRect();
    return {
      top: rowRect.top - scrollerRect.top + dom.editorScroll.scrollTop,
      height: rowRect.height || lineHeight,
    };
  }

  function revealCaret() {
    var metrics = caretMetrics();
    var view = dom.editorScroll;

    // 这次校正是编辑器为了让光标保持在视野内，而不是读者在移动窗格：
    // 标记它，避免分栏同步在每次按键时把阅读窗格一起拖走。
    var before = view.scrollTop;
    if (metrics.top - view.scrollTop < 60) {
      view.scrollTop = Math.max(0, metrics.top - 60);
    } else if (metrics.top - view.scrollTop > view.clientHeight - 120) {
      // 光标下方的留白是为接下来的行预备的。到了文档末尾已经没有后续内容，
      // 这段留白随之塌缩，窗格便会一路滚到底——与浏览器自身钳制的位置相同，
      // 也正是按下 End 后视图没能到底的原因。
      view.scrollTop = Math.min(view.scrollHeight - view.clientHeight,
                                metrics.top - view.clientHeight + 120);
    }
    // 只在正在输入字符时声明位置——这次校正本来就是为了这种情形。在此之外，光标移动
    // 意味着读者在导航（Ctrl+End、PageDown、方向键、查找命中），阅读窗格本就应当跟着
    // 走：把这些滚动也声明为自己放置的，正是按下 End 后它被落在后面、差了整整一屏的
    // 原因。
    if (view.scrollTop !== before && Date.now() < editorTypingUntil) {
      placedEditorAt = Date.now();
      placedEditorValue = view.scrollTop;
    }
  }

  function typewriterFollow() {
    if (!state.config || !state.config.typewriter) { return; }
    var metrics = caretMetrics();
    dom.editorScroll.scrollTop = Math.max(0,
      metrics.top + metrics.height / 2 - dom.editorScroll.clientHeight / 2);
    syncPreviewFromEditor();
  }

  var typewriterFrame = 0;

  /**
   * 真实的按键通过 input 事件到达，此时也必须重新居中——这正是该模式的意义所在。
   * 它在高亮层重绘*之后*的那一帧运行，以保证读取到的行几何信息是最新的。
   */
  function scheduleTypewriter() {
    if (!state.config || !state.config.typewriter || typewriterFrame) { return; }
    typewriterFrame = requestAnimationFrame(function () {
      typewriterFrame = 0;
      typewriterFollow();
    });
  }

  // ----------------------------------------------------------- 查找 / 替换

  function buildMatches(query) {
    var tab = activeTab();
    if (!tab || !query) { return []; }

    var expression;
    var results = [];

    try {
      expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    } catch (error) {
      return [];
    }

    var match;
    var guard = 0;
    while ((match = expression.exec(tab.text)) && guard++ < 20000) {
      if (match[0] === '') { expression.lastIndex++; continue; }
      results.push({ start: match.index, end: match.index + match[0].length });
    }
    return results;
  }

  function applyFindHighlight() {
    var byLine = new Map();
    var lineOf = [];
    var text = dom.editor.value;

    // 命中结果按文档顺序到达，因此行计数器只需一路向前：
    // 旧实现为每个命中都切分一次整篇文档。
    var line = 0;
    var lineStart = 0;
    var scanned = 0;
    state.find.matches.forEach(function (match) {
      for (;;) {
        var breakAt = text.indexOf('\n', scanned);
        if (breakAt < 0 || breakAt >= match.start) { break; }
        line++;
        lineStart = breakAt + 1;
        scanned = breakAt + 1;
      }
      var list = byLine.get(line) || [];
      list.push([match.start - lineStart, match.end - lineStart]);
      byLine.set(line, list);
      lineOf.push({ line: line, from: match.start - lineStart, to: match.end - lineStart });
    });

    var touched = [];
    state.find.byLine.forEach(function (value, index) { touched.push(index); });
    byLine.forEach(function (value, index) { touched.push(index); });

    state.find.byLine = byLine;
    // 每个命中所在的位置，与 matches 一一对应，
    // 这样在命中之间跳转时无需重新扫描文档就能知道光标去了哪一行。
    state.find.lineOf = lineOf;
    repaintLines(touched);
    markCurrentMatch();
  }

  /**
   * 查找栏当前停留的命中，以行内区间的形式表示。没有它时，所有命中都画得一模一样，
   * 像 "#" 这样的单字符查询根本看不出查找栏究竟跳到了哪一个。
   */
  var findActive = null;

  function markCurrentMatch() {
    var previous = findActive;
    var spot = state.find.lineOf ? state.find.lineOf[state.find.index] : null;
    findActive = spot ? { line: spot.line, start: spot.from, end: spot.to } : null;

    // 只有角色发生变化的那两行需要重绘。
    var touched = [];
    if (previous && (!findActive || previous.line !== findActive.line ||
        previous.start !== findActive.start)) { touched.push(previous.line); }
    if (findActive) { touched.push(findActive.line); }
    if (touched.length) { repaintLines(touched); }
  }

  /**
   * 只重绘列出的这些行，并复用缓存的高亮状态。查找高亮只重写带有（或曾带有）命中的
   * 行，因此在大文件上更换查询词的开销取决于命中数量，而不是文档大小。
   */
  function repaintLines(indices) {
    if (!decoration.lines || !indices.length) { return; }

    var unique = [];
    var seen = {};
    indices.forEach(function (index) {
      if (!seen[index] && index >= 0 && index < decoration.lines.length && lineIsRendered(index)) {
        seen[index] = true;
        unique.push(index);
      }
    });
    if (!unique.length) { return; }
    unique.sort(function (a, b) { return a - b; });

    var find = state.find.byLine.size ? state.find.byLine : null;
    var runStart = unique[0];
    var runEnd = unique[0] + 1;

    for (var i = 1; i <= unique.length; i++) {
      if (i < unique.length && unique[i] === runEnd) { runEnd = unique[i] + 1; continue; }

      var markup = [];
      for (var line = runStart; line < runEnd; line++) {
        markup.push(lineMarkup(decoration.lines[line], decoration.states[line],
          find, line, decoration.plain));
      }
      replaceLineRegion(runStart, runEnd, runEnd, decoration.lines, markup);

      if (i < unique.length) { runStart = unique[i]; runEnd = runStart + 1; }
    }
  }

  function runFind(reveal, focusHit) {
    var query = dom.findInput.value;
    var tab = activeTab();

    if (!tab || !query) {
      state.find.matches = [];
      state.find.index = -1;
      dom.findCount.textContent = '0/0';
      var stale = [];
      state.find.byLine.forEach(function (value, index) { stale.push(index); });
      state.find.byLine = new Map();
      state.find.lineOf = null;
      findActive = null;
      repaintLines(stale);
      return;
    }

    state.find.matches = buildMatches(query);
    state.find.index = state.find.matches.length ? 0 : -1;

    if (reveal) {
      // 在查找框获得焦点之后读取只会得到 0：只要另一个控件获得焦点，Chromium 就会
      // 丢弃编辑器的选区，而“0 之后的第一个命中”就是文档中的第一个命中。
      // 因此退回到上一次放置的位置，那才是用户真正停下的地方。
      var caretOffsets = readCaretOffsets();
      var caret = caretOffsets ? caretOffsets.start : lastCaret.start;
      for (var i = 0; i < state.find.matches.length; i++) {
        if (state.find.matches[i].start >= caret) { state.find.index = i; break; }
      }
    }

    dom.findCount.textContent = (state.find.index + 1) + '/' + state.find.matches.length;
    applyFindHighlight();
    if (reveal && focusHit !== false) { focusMatch(); }
  }

  function focusMatch() {
    var match = state.find.matches[state.find.index];
    if (!match) { return; }

    // 过去显示命中项会把光标从查找框里拽出来，于是第一个字符之后输入的字符都跑进了
    // 笔记正文——开启自动保存时还会直接写进文件。因此改为先移动编辑器的选区，
    // 再把焦点交还给原本持有它的控件。
    var focused = document.activeElement;

    // 这里光标会被移动两三次——编辑器取得焦点、定位到命中项、再把焦点交还查找框——
    // 每一步都会报告一次光标位置。这段时间内大纲保持不动，最后只标记一次，
    // 用的是真正稳定下来的位置。
    outlineQuiet = true;
    try {
      dom.editor.focus();
      dom.editor.setSelectionRange(match.start, match.end);
      revealCaret();
      syncPreviewFromEditor();
      // 在编辑器仍持有焦点时标记：下面的状态处理要在焦点交还查找框之后运行，
      // 那时已经读不到光标了。
      updateOutlineCursor(caretLine().line);

      if (focused && focused !== dom.editor && focused.focus) { focused.focus(); }
    } finally {
      outlineQuiet = false;
    }
    findMovedCaret = true;
    updateCursorStatus();
    dom.findCount.textContent = (state.find.index + 1) + '/' + state.find.matches.length;
  }

  var outlineQuiet = false;

  function stepMatch(delta) {
    if (!state.find.matches.length) { return; }
    var total = state.find.matches.length;
    state.find.index = ((state.find.index + delta) % total + total) % total;
    markCurrentMatch();
    focusMatch();
  }

  function replaceCurrent() {
    var match = state.find.matches[state.find.index];
    if (!match) { return; }
    var replacement = dom.replaceInput.value;
    dom.editor.setRangeText(replacement, match.start, match.end, 'preserve');
    commitEdit(match.start, match.start + replacement.length, true);
    runFind(false);
    focusMatch();
  }

  function replaceAll() {
    var tab = activeTab();
    var matches = state.find.matches;
    if (!tab || !matches.length) { return; }

    var replacement = dom.replaceInput.value;
    var pieces = [];
    var cursor = 0;
    matches.forEach(function (match) {
      pieces.push(tab.text.slice(cursor, match.start), replacement);
      cursor = match.end;
    });
    pieces.push(tab.text.slice(cursor));

    dom.editor.value = pieces.join('');
    commitEdit(0, 0, true);
    toast('已替换 ' + matches.length + ' 处');
    runFind(false);
  }

  function openFind() {
    dom.findbar.classList.add('is-on');
    dom.btnFind.classList.add('is-on');
    var selection = dom.editor.value.slice(dom.editor.selectionStart, dom.editor.selectionEnd);
    if (selection && selection.indexOf('\n') < 0) { dom.findInput.value = selection; }
    findMovedCaret = false;
    restoreFindPlacement();
    dom.findInput.focus();
    dom.findInput.select();
    // 查找框会保留上次输入的内容，因此过去一打开查找栏就把光标带到那个命中项——
    // 打开再关闭就把读者挪走了。命中仍然会标记，当前项也仍从光标处取；
    // 真正跳到命中项上应当是方向键和 Enter 的职责。
    runFind(true, false);
  }

  function closeFind() {
    dom.findbar.classList.remove('is-on');
    dom.btnFind.classList.remove('is-on');

    // 下面的重绘会替换掉带命中的那些行，而光标正停在查找栏曾跳到的命中项上。
    // 因此先读取偏移量再放回去，这样关闭查找栏后你仍停留在刚才查找的位置。
    //
    // 只有在编辑器仍持有选区时才能读到位，而现在并非如此：光标在查找框里，
    // 只要另一个控件获得焦点，Chromium 就会丢弃编辑器的选区。
    // 因此退回到上一次放置的位置，也就是查找栏跳到的那个命中项。
    var caret = readCaretOffsets() || lastCaret;

    state.find.matches = [];
    var stale = [];
    state.find.byLine.forEach(function (value, index) { stale.push(index); });
    state.find.byLine = new Map();
    state.find.lineOf = null;
    findActive = null;
    repaintLines(stale);

    // 重新放置光标可能让浏览器把它滚入视野。
    // 若没有进行查找，读者在文档中的位置必须不受影响。
    var keepScroll = dom.editorScroll.scrollTop;
    dom.editor.focus();
    if (caret) {
      // 收拢到命中项的起始处，而不是让它保持选中：查找栏消失后选区仍会留在文字上，
      // 看起来就像查找结果一直卡在那里。
      placeCaret(caret.start, caret.start);
      // 如果视图仍停在重绘后的位置，仅把光标放回去还不够：关闭查找栏的意义就在于
      // 从你刚才所在的命中项继续。这只在查找确实移动过光标时才成立——
      // 打开再关闭查找栏，视图必须停在读者滚动到的位置。
      if (findMovedCaret) { revealCaret(); } else { dom.editorScroll.scrollTop = keepScroll; }
    }

  }

  /** 查找栏打开期间查找是否移动过光标。 */
  var findMovedCaret = false;

  // ---------------------------------------------------------------- 状态栏

  /**
   * 光标位置读数开销很小，可以立即更新；字数和字节数计数要遍历整篇文档，
   * 因此在一阵连续输入之后才跟上，而不是每次按键都跑一遍。
   */
  function updateStatusBar(immediate) {
    updateCursorStatus();
    clearTimeout(statsTimer);
    if (immediate) {
      updateDocumentStats();
    } else {
      // 统计字数要遍历整篇文档，因此文档越大，计数更新前的静默期越长。
      var tab = activeTab();
      var delay = tab && tab.text.length > 400000 ? 700 : 160;
      statsTimer = setTimeout(updateDocumentStats, delay);
    }
  }

  var statsTimer = 0;

  /**
   * 光标位置：字符偏移量以及所在行号（从 1 开始）。
   *
   * 当其他控件持有焦点时，编辑器的选区已经不存在，实时读取只会返回 0，
   * 过去这会令光标读数和大纲标记一起跳到文件顶部，因此改用最近一次已知的光标位置
   * 作为兜底。只有编辑器确实持有焦点时才信任实时读取：焦点移走之后的一瞬间，
   * 它仍可能返回过期的范围。
   */
  function caretLine() {
    var offsets = document.activeElement === dom.editor ? readCaretOffsets() : null;
    var position = offsets ? offsets.start : lastCaret.start;
    return { position: position, line: lineIndexOfOffset(position) + 1 };
  }

  function updateCursorStatus() {
    var tab = activeTab();
    if (!tab) { return; }

    var caret = caretLine();
    var position = caret.position;
    var line = caret.line;
    var lineStart = decoration.starts && decoration.starts[line - 1] != null
      ? decoration.starts[line - 1] : tab.text.lastIndexOf('\n', position - 1) + 1;

    dom.statusCursor.textContent = '行 ' + line + ', 列 ' + (position - lineStart + 1);
    dom.statusMode.textContent = MODE_LABEL[document.documentElement.dataset.mode] || '分栏';
    // 查找步骤在来回移动光标期间，大纲保持不动；等这一步落定后再更新一次。
    // 否则每个中间位置都会重绘标记，看上去就是不停闪烁。
    //
    // 只有编辑器仍能看到的光标才会移动标记。焦点离开编辑器——落到大纲行、工具栏
    // 按钮或查找框上——时读不到光标，而兜底值是上一次放置的位置，
    // 因此过去标记会在大纲行自己的处理函数执行之前就跳走。
    // 由应用自身发起的移动会在发生处直接标记大纲（参见 `focusMatch`）。
    if (!outlineQuiet && document.activeElement === dom.editor) { updateOutlineCursor(line); }
  }

  /**
   * 高亮光标所在的小节。样式表一开始就有 .is-current 的规则，但从来没有任何代码
   * 设置它，因此大纲从不跟随文档。
   */
  function updateOutlineCursor(line) {
    pendingOutlineLine = line;
    if (outlineCursorFrame) { return; }
    outlineCursorFrame = requestAnimationFrame(function () {
      outlineCursorFrame = 0;
      applyOutlineCursor(pendingOutlineLine);
    });
  }

  // 在查找栏中走一步会多次移动光标——先聚焦，再定位到命中项，然后把焦点交还查找框，
  // 每一步都会报告一次光标位置。每次报告都标记大纲会让高亮掠过它出发的位置，
  // 表现为一次闪烁。这里把更新合并为每帧一次，因此只会绘制光标最终稳定之处。
  var outlineCursorFrame = 0;
  var pendingOutlineLine = 1;

  /**
   * 在同一次绘制中重新应用标记，而不是等到下一帧。用于大纲列表刚刚重建的情形：
   * 替换出来的条目不带标记，若再等一帧，高亮就会缺失一次绘制。
   */
  function refreshOutlineMarker() {
    pendingOutlineLine = caretLine().line;
    applyOutlineCursor(pendingOutlineLine);
  }

  function applyOutlineCursor(line) {
    var tab = activeTab();
    if (!tab || !tab.headings || !tab.headings.length) { return; }

    // 标题行来自上一次解析；`line` 来自此刻的文本。两者只有在解析追上文本之后才
    // 具有可比性。在标题上方按下 Enter 会把光标移到标题原先占用的行上，
    // 若在预览还落后一个防抖周期时就拿来比较，那几帧里会点亮*下一个*标题——
    // 每当在某个标题上方加一行，标记就会闪一下。
    if (tab.headingsText !== tab.text) { return; }

    // 这里的 `line` 从 1 开始，而标题自身的行号从 0 开始。
    markOutline(outlineIndexForLine(line - 1));
  }

  /**
   * 所在小节包含源码行 `line` 的标题下标，没有则为 -1。
   *
   * 这是“当前属于哪一节”的唯一答案，光标读数与两个窗格的视口读数都用它。VNote 的阅读器
   * 把*顶部行*扫描和*当前标题*扫描交给同一个函数处理（`NodeLineMapper.
   * binarySearchTopNode`），它的正因如此才从不会与所描述的窗格产生分歧：
   * 用同样的方式提问，两者就不可能给出不同答案。这里两个窗格仍然各自测量几何信息——
   * 必须如此，它们的排版不同——但会把结果交给这个函数，
   * 因此标题边界在两侧会落在同一帧上。
   *
   * 用二分查找是因为它会在每一帧滚动和每一次光标报告中运行，而 `headings` 按行号有序。
   */
  function outlineIndexForLine(line) {
    var tab = activeTab();
    var headings = tab && tab.headings;
    if (!headings || !headings.length) { return -1; }

    var low = 0;
    var high = headings.length - 1;
    var found = -1;
    while (low <= high) {
      var mid = (low + high) >> 1;
      if (headings[mid].line <= line) { found = mid; low = mid + 1; }
      else { high = mid - 1; }
    }
    return found;
  }

  /** 把标记放到标题 `index` 上；-1 表示清除。 */
  function markOutline(index) {
    var items = dom.outline.querySelectorAll('.outline-item');
    Array.prototype.forEach.call(items, function (node, item) {
      node.classList.toggle('is-current', item === index);
    });
  }

  /**
   * 编辑视口顶部的行号（从 1 开始）；无法读取时返回 null。
   *
   * 这里过去用的是 `caretRangeFromPoint` 命中测试，它会在每次滚动事件时强制同步排版
   * （性能分析显示它占一次滚动的 8%）。现在改为 `editorViewportAnchor` 中的二分查找，
   * 直接测量所需的行，而不是从滚动偏移量推算行数——推算只在每行都恰好占一行时才精确，
   * 而折行的段落并非如此。
   *
   * 行取自*内容*顶部，与预览定位所用的原点相同，
   * 这样两个窗格回答“顶部是哪一行”的方式就一致了。
   */
  function viewportTopLine() {
    var anchor = editorViewportAnchor(editorTopPadding());
    return anchor ? anchor.line : null;
  }

  /**
   * 编辑视口顶部下方的那一行，以及视口从该行内部多深处开始；未绘制任何内容时返回 null。
   *
   * 第二个数值是折行时两个窗格能够对齐的关键。一个折行的源码行在编辑器里占好几行，
   * 在预览里也占好几行，滚入其中时必须按该高度的比例传递——只数整行的话，
   * 无论读者已深入到何种程度，都只会报告该行的起始位置。
   *
   * 行的位置是实时读取的，而不是取自上次绘制窗口时缓存的表。那份缓存是按更早的排版
   * 测量的，而过期条目不会醒目地失败：二分查找只是返回一个离窗格顶部很远的行
   * （1600 行的文件里相差 25 行），阅读窗格与源码相差一整屏就是这么来的。
   * 相比之下，二分查找背后多读几个矩形完全不值一提。
   */
  function editorViewportAnchor(probePx) {
    var lines = decoration.lines;
    var node = decoration.windowNode;
    if (!lines || !lines.length || !node || !node.children.length) { return null; }

    var first = decoration.windowFirst;
    var count = node.children.length;
    // 同步逻辑想要紧贴上边缘的那一行；大纲则想要往里几像素的那一行，
    // 这样刚进入窗格的标题就已经算作正在阅读的小节——预览自身的探测也是这样。
    var paneTop = dom.editorScroll.getBoundingClientRect().top + (probePx || 0);

    /*
     * 盒子跨越窗格上边缘的那一行。
     *
     * 用扫描而不是二分查找：折叠段内的行位于 `content-visibility: auto` 的子树中，
     * 引擎为它们报告的盒子是占位值，并不按位置排序——对它做二分查找会返回离屏幕上的
     * 行很远的一行，进而把阅读窗格也带走。按文档顺序读取这些盒子，
     * 取第一个不完全位于窗格上方的，才与读者看到的一致。
     */
    for (var i = 0; i < count; i++) {
      var rect = node.children[i].getBoundingClientRect();
      if (rect.bottom <= paneTop + 1) { continue; }
      var height = rect.height || editorLineHeight();
      var into = height > 0 ? Math.min(1, Math.max(0, (paneTop - rect.top) / height)) : 0;
      return {
        line: Math.min(lines.length, first + i + 1),
        fraction: into,
        // 该位置此刻在内容中的位置，这样重绘时就能按变化量校正，
        // 而不是强行恢复旧的偏移量。
        at: dom.editorScroll.scrollTop + (rect.top - paneTop) + into * height,
      };
    }
    return null;
  }

  /**
   * 窗格正在显示的标题下标，没有则为 -1。
   *
   * `line` 是该窗格顶部的源码位置，因此答案就是正在阅读的小节——只有一个例外，
   * 取自 tocbot 的 `getTopHeader`：
   *
   *     if (i === headings.length - 1) {
   *       // 这样页面上最后一个标题也能被滚动到。
   *
   * 当扫描越过列表末尾时，tocbot 让最后一个标题胜出，因为文档最后一节可能短得永远
   * 到不了窗格顶部——否则滚到短文件底部时，标记会永远停在前一节上。这里的判断依据是
   * 窗格而不是列表：意图相同，只是写在了无需把文档排版到末尾也能检查的地方。
   */
  function outlineIndexForPane(pane, line) {
    var tab = activeTab();
    var headings = tab && tab.headings;
    if (!headings || !headings.length) { return -1; }
    if (paneAtEnd(pane)) { return headings.length - 1; }
    return outlineIndexForLine(line);
  }

  /**
   * 读者滚动时让标记跟随屏幕上的内容。
   *
   * 移动光标仍然优先，但滚轮和滚动条不会改变光标位置；没有这一步，读者明明在看别处，
   * 大纲却仍停在正在编辑的那一节上。
   */
  function updateOutlineFromViewport() {
    var tab = activeTab();
    if (!tab || !tab.headings || !tab.headings.length) { return; }
    if (tab.headingsText !== tab.text) { return; }
    // 程序化的移动（查找步骤、大纲跳转）只在落点处设置一次标记。
    // 若逐帧跟随，高亮会沿途扫过中间的每一节。
    if (outlineQuiet) { return; }
    // 输入并不是读者在移动窗格：它引起的唯一滚动是编辑器为了让光标保持在视野内，
    // 而标记刚刚已经落在光标所在的小节上。若改由视口来回答，标记会被拉回拥有上边缘的
    // 那一节——当光标位于窗格偏下位置时就是上一节——于是每次按键高亮都会在两行之间
    // 闪烁。
    if (Date.now() < editorTypingUntil) { return; }

    if (document.documentElement.dataset.mode === 'read') {
      var anchor = previewAnchorLine();
      markOutline(outlineIndexForPane(dom.previewScroll,
        anchor ? anchor.line : previewLineForOffset(dom.previewScroll.scrollTop)));
      return;
    }

    var line = viewportTopLine();
    if (line != null) { markOutline(outlineIndexForPane(dom.editorScroll, line - 1)); }
  }

  function updateDocumentStats() {
    var tab = activeTab();
    if (!tab) { return; }

    var text = tab.text;
    var stats = countWords(text);
    var minutes = Math.max(1, Math.round((stats.cjk + stats.words) / 300));

    dom.statusPath.textContent = tab.path || tabTitle(tab);
    dom.statusPath.title = tab.path ? '点击复制路径：' + tab.path : '尚未保存到文件';
    dom.statusEncoding.textContent = tab.path
      ? (tab.encoding.toUpperCase() + ' · ' + humanSize(new Blob([text]).size))
      : 'UTF-8';
    dom.statusCount.textContent = (stats.cjk + stats.words) + ' 字 / ' + stats.chars +
      ' 字符 · ' + minutes + ' 分钟';
  }

  // ------------------------------------------------------------- 滚动同步

  var activating = false;

  var windowFrame = 0;

  // 滚动同步状态。
  //
  // 读者正在移动的窗格是主导方；另一侧会在下一帧被放到对应位置。有两类滚动事件并非
  // 读者在移动内容，绝不能触发同步：
  //
  //   - 本代码刚刚放置窗格所产生的回声（放置窗格本身就会触发滚动事件）；
  //   - revealCaret() 在输入时做的小幅校正。
  //
  var placedEditorAt = 0;
  var placedPreviewAt = 0;
  // 本代码最后写入每个窗格的数值：若滚动事件发生时窗格仍停在这个值上，那就是放置
  // 产生的回声，否则就是读者在滚动。按位置而不是按时间判断，可以避免一连串快速重复
  // 按键被误判为回声而丢弃。
  var placedEditorValue = -1;
  var placedPreviewValue = -1;
  // 输入导致编辑器滚动只有一个原因：让光标保持在视野内。这不是读者在移动窗格，
  // 若跟随它，每敲一次键都会把阅读窗格一起拖走——旧代码通过要求滚轮/拖拽手势来阻止，
  // 结果连拖动滚动条也完全无法同步。按下一个字符键后的短时间窗口是更精细的做法：
  // 它能覆盖光标的场景，又不会影响滚轮、拖拽和导航键。
  var editorTypingUntil = 0;
  var TYPING_MS = 250;
  var syncFrame = 0;
  var syncLeader = '';

  /**
   * 要让源码位置 `line` 到达顶部，预览需要滚动到的位置。
   *
   * 两个窗格是通过源文档而不是通过各自的像素对齐的：每个已渲染的块都知道自己来自哪些
   * 源码行，因此位置以行号传递，只有块*内部*的那一部分按该块渲染高度的比例换算。
   * 这正是 VS Code 的 Markdown 预览同步所采用的形式（`scroll-sync.ts` 也在相邻块
   * 之间做同样的插值），也是两侧以不同宽度排版时唯一成立的映射——一个表格或代码块
   * 在左侧只占两行，在右侧却几乎占满一屏。
   */
  function previewTopForLine(line) {
    if (!previewDoc.blocks.length) { return null; }
    var index = previewBlockForLine(Math.floor(line));
    if (index < 0) { return null; }

    var span = Math.max(1, previewDoc.spans[index] || 1);
    var into = Math.min(1, Math.max(0, (line - (previewDoc.starts[index] || 0)) / span));

    // 屏幕上的块可以被测量，它自己的盒子才是真相：高度表给出的位置，其准确度取决于
    // 它上方那些未绘制块的估算值。
    var nodes = previewDoc.chunks[index];
    var element = nodes && nodes.length ? nodes[0] : null;
    if (element && element.nodeType === 1) {
      var view = dom.previewScroll;
      var rect = element.getBoundingClientRect();
      if (rect.height > 0) {
        return view.scrollTop + (rect.top - view.getBoundingClientRect().top) +
          into * rect.height - previewTopPadding();
      }
    }
    return previewBlockTop(index) + into * blockHeight(index);
  }

  /** 高度 `offset` 处的源码位置（行号，可能带小数）。 */
  function previewLineForOffset(offset) {
    var found = previewBlockAtOffset(offset);
    if (found.index < 0) { return 0; }
    var span = Math.max(1, previewDoc.spans[found.index] || 1);
    var height = blockHeight(found.index) || 1;
    var into = Math.min(1, Math.max(0, found.into / height));
    return (previewDoc.starts[found.index] || 0) + into * span;
  }

  /** 为与编辑器视口对齐，预览需要滚动到的位置。 */
  function previewTopForEditor() {
    var tab = activeTab();
    // 块表足以完成整个映射——只有一两个标题、甚至没有标题的文档同样能对齐，
    // 而过去这种情况会退化为按比例缩放。
    if (!tab || !previewDoc.blocks.length) { return null; }
    if (tab.headingsText !== tab.text) { return null; }

    var anchor = editorViewportAnchor(editorTopPadding());
    if (!anchor) { return null; }
    // 锚点的行号从 1 开始，而块表从 0 开始。
    return previewTopForLine(anchor.line - 1 + anchor.fraction);
  }

  /**
   * 源码位置 `line` 的顶部在编辑器可滚动内容中的位置。
   *
   * 已绘制的行会给出精确答案，包括折行后占据的行数；
   * 平均行高只是未绘制行的兜底方案。
   */
  function editorTopForLine(line) {
    var lines = decoration.lines;
    if (!lines || !lines.length) { return null; }
    var index = Math.min(lines.length - 1, Math.max(0, Math.floor(line)));
    var fraction = Math.min(1, Math.max(0, line - index));
    // 滚动位置是从*内容*顶部算起的，而两个窗格在第一行上方都留有内边距。把它遗漏
    // 会让每次定位都把这层内边距滚掉——滚动编辑器之后阅读窗格的位置比滚动预览之后
    // 高 30px，这正是两个方向不一致的地方。
    var padding = editorTopPadding();

    var node = lineNode(index);
    if (node) {
      var rect = node.getBoundingClientRect();
      var top = rect.top - dom.editorScroll.getBoundingClientRect().top + dom.editorScroll.scrollTop;
      return top + fraction * rect.height - padding;
    }

    /*
     * 位于已绘制窗口之外：落在某个折叠段里，其高度浏览器已经在使用，
     * 因此就在这一段内部做插值。过去是把整个滚动高度除以行数，
     * 误差可达几十行：折叠段是按*不折行*的行估算的，比它们所代表的真实行更矮，
     * 而且距离越远误差越大。
     */
    var first = decoration.windowFirst;
    var last = decoration.windowLast;
    var scrollHeight = dom.editorScroll.scrollHeight || 0;
    if (index < first) {
      var aboveHeight = decoration.windowTop;
      return first > 0 ? aboveHeight * ((index + fraction) / first) - padding : 0;
    }
    if (index >= last) {
      var belowTop = decoration.windowBottom;
      var belowHeight = Math.max(0, scrollHeight - belowTop);
      var belowCount = Math.max(1, lines.length - last);
      return belowTop + ((index - last) + fraction) / belowCount * belowHeight - padding;
    }

    var average = scrollHeight / lines.length;
    if (!(average > 4)) { average = editorLineHeight(); }
    return (index + fraction) * average - padding;
  }

  /** 为与预览视口对齐，编辑器需要滚动到的位置。 */
  function editorTopForPreview() {
    var tab = activeTab();
    if (!tab || !previewDoc.blocks.length) { return null; }
    // 窗格显示的是真实块，而每个块知道自己来自哪一行，因此位置取自顶部的已绘制块——
    // 与正向映射的做法相同。改从高度表读取，正是这个方向与屏幕内容不一致的原因。
    var anchor = previewAnchorLine();
    var line = anchor ? anchor.line : previewLineForOffset(dom.previewScroll.scrollTop);
    var target = editorTopForLine(line);
    if (target == null) { return null; }
    return Math.min(dom.editorScroll.scrollHeight, Math.max(0, target));
  }

  /**
   * 把 `pane` 放到 `target`；目标未知时按对应比例放置。
   *
   * 会记住这次放置的位置，以便把它产生的滚动事件与读者滚动该窗格区分开。
   */
  function placePane(pane, target, ratio, max) {
    var value = Math.min(max, Math.max(0, target == null ? ratio * max : target));
    if (pane === dom.previewScroll) { placedPreviewAt = Date.now(); placedPreviewValue = value; }
    else if (pane === dom.editorScroll) { placedEditorAt = Date.now(); placedEditorValue = value; }
    pane.scrollTop = value;
  }

  /** `pane` 仍停在上次放置的位置时为真。 */
  function isPlacementEcho(pane) {
    var value = pane === dom.editorScroll ? placedEditorValue : placedPreviewValue;
    return value >= 0 && Math.abs(pane.scrollTop - value) <= 1;
  }

  /** 编辑器的可滚动范围；窗格不滚动时为 0。 */
  function editorScrollRange() {
    return Math.max(0, dom.editorScroll.scrollHeight - dom.editorScroll.clientHeight);
  }

  /**
   * 预览的可滚动范围。
   *
   * 读取缓存值而不是实时值：占位元素由上一次排版写入，
   * 而实时查询 scrollHeight 会在滚动过程中的每一帧都强制重新排版。
   */
  function previewScrollRange() {
    var height = previewDoc.scrollHeight || dom.previewScroll.scrollHeight;
    return Math.max(0, height - dom.previewScroll.clientHeight);
  }

  /** 把预览放到编辑器的当前位置。 */
  function syncPreviewFromEditor() {
    scheduleSync('editor');
  }

  /** 把编辑器放到预览的当前位置。 */
  function syncEditorFromPreview() {
    scheduleSync('preview');
  }

  function scheduleSync(leader) {
    if (activating) { return; }
    if (document.documentElement.dataset.mode !== 'split') { return; }

    syncLeader = leader;
    if (syncFrame) { return; }
    syncFrame = requestAnimationFrame(function () {
      syncFrame = 0;
      followLeader();
    });
  }

  /**
   * 每帧一次，把跟随方放到主导方的内容位置上。
   *
   * 定位依据的是内容而不是比例：编辑器顶部行所属的块，就是预览要去的块；反方向则把
   * 预览的顶部偏移量换算回源码行，再去测量该行。两个以不同宽度显示同一文本的窗格，
   * 单靠比例无法保持同步——一个表格或代码块在右侧有几屏高，在左侧只有两行，
   * 它之后的一切都会漂移。
   */
  function followLeader() {
    if (activating) { return; }
    if (document.documentElement.dataset.mode !== 'split') { return; }

    if (syncLeader === 'editor') {
      var previewMax = previewScrollRange();
      var editorMax = editorScrollRange();
      if (previewMax <= 0) { return; }
      // 两端按定义就是对齐的。编辑器在已绘制窗口之外的高度是估算值，预览则是逐块测量，
      // 因此内容映射永远无法精确到达两端——而且在文档末尾，“顶部放同一行”根本就不是
      // 正确的答案：两个窗格是内容用完了，而不是失去对齐。
      if (dom.editorScroll.scrollTop <= 0) {
        placePane(dom.previewScroll, 0, 0, previewMax);
        return;
      }
      if (editorMax > 0 && dom.editorScroll.scrollTop >= editorMax - 1) {
        settlePreviewAtEnd();
        return;
      }
      var probe = editorViewportAnchor(editorTopPadding());
      var ratio = editorMax > 0 ? dom.editorScroll.scrollTop / editorMax : 0;
      placePane(dom.previewScroll, previewTopForEditor(), ratio, previewMax);
      /*
       * 目标已出现在屏幕上，再放一次。
       *
       * 第一次放置必须经过高度表，而该表对读者与目标之间的块只是估算——在长文档中
       * 会差出大约一节。排版过程会绘制落点附近的块并测量它们，此后同一行就有了真实的
       * 盒子可以瞄准，两个窗格便能精确对齐。
       */
      if (probe) {
        var wantedLine = probe.line - 1 + probe.fraction;
        layoutPreview({ line: wantedLine });
        var exact = previewTopForLine(wantedLine);
        if (exact != null) { placePane(dom.previewScroll, exact, ratio, previewScrollRange()); }
      }
    } else if (syncLeader === 'preview') {
      var editorRange = editorScrollRange();
      var previewRange = previewScrollRange();
      if (editorRange <= 0 || previewRange <= 0) { return; }
      if (dom.previewScroll.scrollTop <= 0) {
        placePane(dom.editorScroll, 0, 0, editorRange);
        return;
      }
      if (dom.previewScroll.scrollTop >= previewRange - 1) {
        settleEditorAtEnd();
        return;
      }
      placePane(dom.editorScroll, editorTopForPreview(),
                dom.previewScroll.scrollTop / previewRange, editorRange);
    }
  }

  /**
   * 把阅读窗格放到文档末尾。
   *
   * 两端按定义就是对齐的——两个窗格是内容见底，而不是对齐出错——因此目标是窗格自身的
   * 末尾，而不是某个源码位置。这个末尾的位置只对已绘制过的块是精确的：
   * 已绘制窗口之外的一切仍带着估算值，而尾部恰恰是跳到末尾时从未绘制过的部分。
   * 放置一次只会落在估算的末尾上；绘制尾部会测量它并移动真正的末尾；之后没有任何
   * 环节去修正这个差值，于是编辑器已经停住，窗格却还能继续滚动。每一轮都会绘制落点
   * 下方的块，再按测回的高度重新放置，两轮即可稳定。
   */
  function settlePreviewAtEnd() {
    var last = previewDoc.blocks.length - 1;
    if (last < 0) { return; }
    var anchor = { line: previewDoc.ends[last] || 0 };

    // 先落到尾部附近——估算值足以把它带进已绘制的窗口——再把窗格推过自己的底部，
    // 让最后一个块与底边齐平。浏览器对这一越界施加的钳制*就是*文档末尾，也是唯一不会
    // 出错的答案：估算错的正是那些从未绘制过的内容的高度，而计算出来的末尾恰恰由这些
    // 高度构成。VS Code 的预览同样依赖这个钳制——它的映射从不计算末尾。
    placePane(dom.previewScroll, previewScrollRange(), 0, previewScrollRange());
    for (var pass = 0; pass < 3; pass++) {
      layoutPreview(anchor);

      var nodes = previewDoc.chunks[last];
      var node = nodes && nodes.length ? nodes[nodes.length - 1] : null;
      if (!node || node.nodeType !== 1) { return; }

      var view = dom.previewScroll;
      var overshoot = node.getBoundingClientRect().bottom -
        view.getBoundingClientRect().bottom + previewTopPadding();
      if (overshoot <= 0.5) { return; }

      var live = Math.max(0, view.scrollHeight - view.clientHeight);
      placePane(view, view.scrollTop + overshoot, 0, live);
      if (view.scrollTop >= live - 1) { return; }
    }
  }

  /** 编辑器同理，它的折叠段高度同样是估算的。 */
  function settleEditorAtEnd() {
    for (var pass = 0; pass < 4; pass++) {
      var end = editorScrollRange();
      placePane(dom.editorScroll, end, 0, end);
      var landed = dom.editorScroll.scrollTop;
      refreshWindowForScroll();
      if (Math.abs(editorScrollRange() - landed) < 1) { return; }
    }
  }

  /** 滚动容器停在自身末尾时为真。 */
  function paneAtEnd(pane) {
    return pane.scrollTop > 0 &&
      pane.scrollTop >= pane.scrollHeight - pane.clientHeight - 1;
  }

  /** 按滚动容器当前的高度把它放回自身末尾。 */
  function pinPaneToEnd(pane) {
    var end = Math.max(0, pane.scrollHeight - pane.clientHeight);
    if (pane.scrollTop >= end) { return; }
    placePane(pane, end, 0, end);
  }

  /**
   * 判断一次滚动事件是否意味着读者在移动那个窗格。
   *
   * 只要不是本代码刚刚造成的滚动，就都算读者所为——滚轮、拖动滚动条、点击滚动条轨道、
   * Page 键、惯性滚动，全都如此。它取代的版本试图识别自己知道的手势（滚轮、
   * mousedown、keydown），其余一概忽略，结果悄悄导致拖动预览的滚动条——这种操作根本
   * 不产生手势事件——完全无法同步。VS Code 的预览同步也是这个立场：
   * 它只屏蔽自身代码引发的滚动事件。
   */
  function readerIsScrolling(pane) {
    if (pane === dom.editorScroll && Date.now() < editorTypingUntil) { return false; }
    return !isPlacementEcho(pane);
  }


  // ---------------------------------------------------------------- 文件读写

  function openPath(path, defer) {
    var existing = state.tabs.find(function (tab) {
      return tab.path && tab.path.toLowerCase() === String(path).toLowerCase();
    });
    if (existing) {
      if (!defer) { activateTab(existing.id); }
      return Promise.resolve();
    }

    return hostCall('openPath', { path: path }).then(function (data) {
      if (!data || !data.path || data.error) {
        if (data && data.error) { toast(data.error, true); }
        return;
      }
      var tab = makeTab({
        path: data.path,
        name: data.name,
        text: data.text,
        encoding: data.encoding,
      });
      // 会话恢复会传入 `defer`：先在标签条中显示标签，
      // 但直到该标签真正被打开之前都不渲染文档。
      if (defer) { renderTabs(); } else { activateTab(tab.id); }
      rememberRecent();
    }).catch(function (error) { toast(error.message, true); });
  }

  function openDialog() {
    hostCall('openDialog').then(function (data) {
      if (!data || data.canceled) { return; }
      if (data.error) { toast(data.error, true); return; }

      var existing = state.tabs.find(function (tab) {
        return tab.path && tab.path.toLowerCase() === String(data.path).toLowerCase();
      });
      if (existing) { activateTab(existing.id); return; }

      var tab = makeTab({
        path: data.path,
        name: data.name,
        text: data.text,
        encoding: data.encoding,
      });
      activateTab(tab.id);
      rememberRecent();
    }).catch(function (error) { toast(error.message, true); });
  }

  function saveTab(forceDialog) {
    var tab = activeTab();
    if (!tab) { return Promise.resolve(false); }
    persistTabView(tab);

    if (!tab.path || forceDialog) {
      var suggested = tab.path ? basename(tab.path) : (tab.name === '未命名' ? '未命名.md' : tab.name);
      if (!/\.(md|markdown|mdown|mkd|txt)$/i.test(suggested)) { suggested += '.md'; }

      return hostCall('saveAs', { text: tab.text, suggested: suggested }).then(function (data) {
        if (!data || data.canceled) { return false; }
        applySaved(tab, data);
        return true;
      }).catch(function (error) { toast(error.message, true); return false; });
    }

    return hostCall('save', { path: tab.path, text: tab.text }).then(function (data) {
      if (data && data.error) { toast(data.error, true); return false; }
      applySaved(tab, data || { path: tab.path });
      return true;
    }).catch(function (error) { toast(error.message, true); return false; });
  }

  function applySaved(tab, data) {
    tab.path = data.path;
    tab.name = data.name || basename(data.path);
    tab.savedText = tab.text;
    tab.dirty = false;
    syncDocDirectory(tab);
    renderTabs();
    updateStatusBar();
    updateWindowTitle();
    rememberRecent();
    toast('已保存 · ' + basename(tab.path));
  }

  var autoSaveTimer = 0;
  function scheduleAutoSave() {
    if (!state.config || !state.config.autoSave) { return; }
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(function () {
      // 自动保存按缓冲区进行（VNote 也是这样处理的），而不是“你碰巧正在看的那个
      // 缓冲区”。只保存当前标签会丢工作：编辑一个笔记，在延时内切走，
      // 定时器却在切过去的那个标签上触发，那次编辑就永远不会被写入。
      state.tabs.forEach(function (tab) {
        if (!tab.path || !tab.dirty) { return; }

        var text = tab.text;
        hostCall('save', { path: tab.path, text: text }).then(function () {
          // 写入进行期间输入的任何内容都会让它保持未保存状态。
          tab.savedText = text;
          tab.dirty = tab.text !== text;
          renderTabs();
          if (tab === activeTab()) { updateWindowTitle(); }
        }).catch(function () {});
      });
    }, 2500);
  }

  function rememberRecent() {
    var tab = activeTab();
    if (!tab || !tab.path || !state.config) { return; }
    var recent = (state.config.recent || []).filter(function (item) {
      return item.toLowerCase() !== tab.path.toLowerCase();
    });
    recent.unshift(tab.path);
    state.config.recent = recent.slice(0, 15);
    saveConfig();
    // 只有“最近打开”这一块变了：在这里重建面板会把整个文件夹树拆掉，
    // 每次打开文件都要重新列出所有已展开的层级。
    renderRecent();
  }

  function insertImageFromFile(file, position) {
    var tab = activeTab();
    if (!tab) { return; }

    if (!tab.path) {
      toast('请先保存文档，图片会放到文档同级的 assets 目录', true);
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      var result = String(reader.result);
      var base64 = result.slice(result.indexOf(',') + 1);
      var extension = (file.name.split('.').pop() || 'png').toLowerCase();

      hostCall('savePastedImage', { base64: base64, extension: extension, docPath: tab.path })
        .then(function (data) {
          if (!data || data.error) { toast(data.error || '保存图片失败', true); return; }
          var snippet = '![' + (file.name.replace(/\.[^.]+$/, '') || 'image') + '](' + data.relative + ')';
          if (position != null) {
            dom.editor.setRangeText(snippet, position, position, 'end');
            commitEdit(position + snippet.length, position + snippet.length, true);
          } else {
            insertBlock(snippet);
          }
          toast('图片已保存到 ' + data.relative);
        })
        .catch(function (error) { toast(error.message, true); });
    };
    reader.readAsDataURL(file);
  }

  // ------------------------------------------------------------- 文件面板

  function renderFilePanel() {
    var html = '';

    if (state.treeRoots.length) {
      // 每个文件夹一段。主体用下标而不是路径作标识，
      // 这样充满引号或反斜杠的路径就不必转义进选择器。
      html += state.treeRoots.map(function (root, index) {
        var collapsed = !!state.treeCollapsed[root];
        return '<div class="tree-root" data-root-index="' + index + '">' +
          '<svg class="icon icon-sm chev' + (collapsed ? '' : ' is-open') + '"><use href="#i-chevron"/></svg>' +
          '<svg class="icon icon-sm"><use href="#i-folder"/></svg>' +
          '<span class="path" title="' + esc(root) + '">' + esc(root) + '</span>' +
          '<button class="ibtn root-remove" data-remove-root="' + index + '" title="移除此文件夹">' +
          '<svg class="icon icon-sm"><use href="#i-close"/></svg></button></div>' +
          '<div class="tree-children" data-root-body="' + index + '"' +
          (collapsed ? ' style="display:none"' : '') + '></div>';
      }).join('');
    } else {
      html += '<div class="empty-hint">还没有添加文件夹<br>' +
        '<button class="outline-item" style="margin-top:10px;text-align:center" id="btnOpenFolder">' +
        '添加文件夹…</button></div>';
    }

    // “最近打开”列表有自己独立的一块，这样打开文件时刷新它无需重建整棵树：
    // 重建意味着每个文件夹一次往返，面板每次都会明显地收起再展开。
    html += '<div id="recentList"></div>';

    // 重建列表会丢掉它的滚动位置，于是每次折叠文件夹、新建文件或“最近打开”变动时，
    // 面板都会猛地跳回顶部。
    var scroll = dom.fileTree.scrollTop;
    dom.fileTree.innerHTML = html;
    dom.fileTree.scrollTop = scroll;

    state.treeRoots.forEach(function (root, index) {
      if (state.treeCollapsed[root]) { return; }
      var body = dom.fileTree.querySelector('[data-root-body="' + index + '"]');
      if (body) { renderTreeLevel(root, body, 0); }
    });

    if (treeSearchQuery) { runTreeSearch(treeSearchQuery); }

    renderRecent();

    var openButton = $('btnOpenFolder');
    if (openButton) { openButton.addEventListener('click', pickFolder); }

    Array.prototype.forEach.call(dom.fileTree.querySelectorAll('.tree-root'), function (row) {
      row.addEventListener('click', function (event) {
        var remove = event.target.closest && event.target.closest('[data-remove-root]');
        if (remove) {
          removeTreeRoot(state.treeRoots[Number(remove.dataset.removeRoot)]);
          return;
        }
        var root = state.treeRoots[Number(row.dataset.rootIndex)];
        if (!root) { return; }
        // 折叠状态按文件夹记录；条目为空表示“展开”，
        // 因此只有用户确实折叠过，才会被记为已折叠。
        state.treeCollapsed[root] = !state.treeCollapsed[root];
        renderFilePanel();
      });
    });
  }

  /** 面板显示的各个文件夹。`treeRoot` 保留为其中第一个。 */
  function setTreeRoots(paths) {
    var seen = {};
    state.treeRoots = (paths || []).filter(function (path) {
      if (!path) { return false; }
      var key = String(path).toLowerCase();
      if (seen[key]) { return false; }
      seen[key] = true;
      return true;
    });
    state.treeRoot = state.treeRoots[0] || '';
    saveTreeRoots();
  }

  function addTreeRoot(path) {
    if (!path) { return; }
    setTreeRoots(state.treeRoots.concat([path]));
  }

  function removeTreeRoot(path) {
    setTreeRoots(state.treeRoots.filter(function (item) { return item !== path; }));
    renderFilePanel();
  }

  function saveTreeRoots() {
    if (!state.config) { return; }
    state.config.folders = state.treeRoots.slice();
    saveConfig();
  }

  /** “最近打开”区块，在打开笔记时单独刷新。 */
  function renderRecent() {
    var box = $('recentList');
    if (!box) { return; }

    var recent = ((state.config && state.config.recent) || []).slice(0, 8);
    if (!recent.length) { box.innerHTML = ''; return; }

    box.innerHTML = '<div class="recent-head">最近打开</div>' + recent.map(function (path) {
      return '<div class="recent-item" data-open="' + esc(path) + '">' +
        '<span class="title">' + esc(basename(path)) + '</span>' +
        '<span class="sub" title="' + esc(path) + '">' + esc(path) + '</span></div>';
    }).join('');

    Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function (node) {
      node.addEventListener('click', function () { openPath(node.dataset.open); });
    });
  }

  function renderTreeLevel(path, container, depth) {
    hostCall('listDir', { path: path }).then(function (data) {
      var entries = (data && data.entries) || [];
      if (!entries.length) {
        container.innerHTML = '<div class="empty-hint" style="padding:12px">没有 Markdown 文件</div>';
        return;
      }

      container.innerHTML = entries.map(function (entry) {
        return '<div class="tree-row" data-path="' + esc(entry.path) + '" data-dir="' +
          (entry.dir ? '1' : '0') + '">' +
          (entry.dir
            ? '<svg class="icon icon-sm chev"><use href="#i-chevron"/></svg>'
            : '<span style="width:13px"></span>') +
          '<svg class="icon icon-sm" style="color:var(--fg-faint)"><use href="#' +
          (entry.dir ? 'i-folder' : 'i-file') + '"/></svg>' +
          '<span class="name">' + esc(entry.name) + '</span></div>' +
          (entry.dir ? '<div class="tree-children" style="display:none"></div>' : '');
      }).join('');

      var rows = Array.prototype.slice.call(container.querySelectorAll(':scope > .tree-row'));

      rows.forEach(function (row) { bindTreeRow(row, depth); });

      // 重新展开用户此前展开过的内容，
      // 这样重建不会把用户眼前的树折叠起来。
      rows.forEach(function (row) {
        if (row.dataset.dir === '1' && state.treeExpanded[row.dataset.path]) {
          openTreeFolder(row, depth, true);
        }
      });
    }).catch(function () { container.innerHTML = ''; });
  }

  // 文件双击打开，与其所在文件夹的行为一致；单击只移动选中项。
  // 文件夹仍然是单击切换展开状态，随后的 dblclick 会让它保持展开。
  function bindTreeRow(row, depth) {
    row.addEventListener('click', function () {
      if (row.dataset.dir === '1') {
        openTreeFolder(row, depth, row.nextElementSibling.style.display === 'none');
        return;
      }
      selectTreeRow(row);
    });
    row.addEventListener('dblclick', function () {
      if (row.dataset.dir === '1') {
        openTreeFolder(row, depth, row.nextElementSibling.style.display === 'none');
        return;
      }
      selectTreeRow(row);
      openPath(row.dataset.path);
    });
  }

  /** 搜索结果是没有子项的条目，因此只需要选中 / 打开两种处理。 */
  function bindFlatRow(row) {
    row.addEventListener('click', function () { selectTreeRow(row); });
    row.addEventListener('dblclick', function () {
      selectTreeRow(row);
      openPath(row.dataset.path);
    });
  }

  function selectTreeRow(row) {
    Array.prototype.forEach.call(dom.fileTree.querySelectorAll('.tree-row.is-active'), function (node) {
      node.classList.remove('is-active');
    });
    row.classList.add('is-active');
  }

  // ------------------------------------------------------------ 文件搜索
  // 输入框每敲一次键都会请求宿主遍历文件夹。查询有效期间，树会被替换成一张扁平的
  // 结果列表；清空后树恢复原状。宿主的遍历有上限，
  // 而令牌机制会丢弃已被后续输入取代的回答。

  var treeSearchQuery = '';
  var treeSearchToken = 0;
  var treeSearchTimer = 0;

  function bindTreeSearch() {
    if (!dom.treeSearch) { return; }

    dom.treeSearch.addEventListener('input', function () {
      treeSearchQuery = dom.treeSearch.value.trim();
      scheduleTreeSearch();
    });

    // Escape 清空输入框，而不会传给编辑器或查找栏。
    dom.treeSearch.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') { return; }
      event.stopPropagation();
      dom.treeSearch.value = '';
      treeSearchQuery = '';
      scheduleTreeSearch();
    });
  }

  function scheduleTreeSearch() {
    if (treeSearchTimer) { clearTimeout(treeSearchTimer); }
    treeSearchTimer = setTimeout(function () {
      treeSearchTimer = 0;
      runTreeSearch(treeSearchQuery);
    }, 120);
  }

  function runTreeSearch(query) {
    if (!state.treeRoots.length) { return; }

    if (!query) {
      treeSearchToken++;
      renderFilePanel();
      return;
    }

    var token = ++treeSearchToken;
    var roots = state.treeRoots.slice();

    // 每个已添加的文件夹都会被搜索，因此结果会标注它来自哪个文件夹，
    // 而不是假定只有一个。
    Promise.all(roots.map(function (root) {
      return hostCall('searchFiles', { root: root, query: query })
        .then(function (data) { return { root: root, data: data }; })
        .catch(function () { return { root: root, data: null }; });
    })).then(function (groups) {
      if (token !== treeSearchToken) { return; }

      var rows = '';
      var truncated = false;
      groups.forEach(function (group) {
        var matches = (group.data && group.data.matches) || [];
        if (group.data && group.data.truncated) { truncated = true; }

        matches.forEach(function (entry) {
          var folder = entry.dir || '';
          if (folder.toLowerCase().indexOf(group.root.toLowerCase()) === 0) {
            folder = folder.slice(group.root.length).replace(/^[\\\/]+/, '');
          }
          if (!folder) { folder = basename(group.root); }
          rows += '<div class="tree-row" data-path="' + esc(entry.path) + '" data-dir="0">' +
            '<span style="width:13px"></span>' +
            '<svg class="icon icon-sm" style="color:var(--fg-faint)"><use href="#i-file"/></svg>' +
            '<span class="name">' + esc(entry.name) + '</span>' +
            '<span class="sub" title="' + esc(entry.dir) + '">' + esc(folder) + '</span>' +
            '</div>';
        });
      });

      var header = '<div class="search-head">在 ' + roots.length + ' 个文件夹中搜索</div>';
      var footer = truncated
        ? '<div class="empty-hint" style="padding:10px">结果太多，只显示前 300 个</div>'
        : '';

      dom.fileTree.innerHTML = header +
        (rows
          ? '<div data-root-body="0">' + rows + '</div>' + footer
          : '<div class="empty-hint" style="padding:12px">没有匹配的文件</div>') +
        '<div id="recentList"></div>';

      renderRecent();

      Array.prototype.forEach.call(dom.fileTree.querySelectorAll('.tree-row'), function (row) {
        bindFlatRow(row);
      });
    }).catch(function () {});
  }

  function openTreeFolder(row, depth, open) {
    var children = row.nextElementSibling;
    var chevron = row.querySelector('.chev');

    children.style.display = open ? 'block' : 'none';
    chevron.classList.toggle('is-open', open);

    if (open) {
      state.treeExpanded[row.dataset.path] = true;
    } else {
      delete state.treeExpanded[row.dataset.path];
    }

    if (open && !children.dataset.loaded && depth < 6) {
      children.dataset.loaded = '1';
      renderTreeLevel(row.dataset.path, children, depth + 1);
    }
  }

  function pickFolder() {
    hostCall('pickFolder', { current: state.treeRoots[0] || '' }).then(function (data) {
      if (!data || data.canceled) { return; }
      // 是添加而不是替换：面板会保留用户选过的每一个文件夹。
      addTreeRoot(data.path);
      state.config.lastFolder = data.path;
      selectSidebarPanel('files', true);
      renderFilePanel();
    }).catch(function (error) { toast(error.message, true); });
  }

  // ------------------------------------------------------- 文件树操作

  function treeContextMenu(event) {
    event.preventDefault();
    var row = event.target.closest && event.target.closest('.tree-row');
    var path = row ? row.dataset.path : '';
    var isFolder = row ? row.dataset.dir === '1' : !!state.treeRoot;
    var folder = isFolder ? path : path.replace(/[\\/][^\\/]*$/, '');

    var items = [
      { key: 'newFile', label: '新建 Markdown 文件', run: function () { createEntry(folder, false); } },
      { key: 'newFolder', label: '新建文件夹', run: function () { createEntry(folder, true); } },
    ];
    if (path) {
      items.push('---',
        { key: 'rename', label: '重命名', shortcut: 'F2', run: function () { renameEntry(path); } },
        { key: 'delete', label: '删除到回收站', run: function () { deleteEntry(path); } });
    }
    items.push('---',
      { key: 'reveal', label: '在资源管理器中显示', run: function () {
        hostCall('reveal', { path: path || state.treeRoot });
      } },
      { key: 'refresh', label: '刷新', run: renderFilePanel });

    showContextMenu(event.clientX, event.clientY, items);
  }

  function createEntry(folder, asFolder) {
    if (!folder) {
      toast('先打开一个文件夹', true);
      return;
    }

    showDialog({
      title: asFolder ? '新建文件夹' : '新建 Markdown 文件',
      message: folder,
      input: true,
      value: asFolder ? '新建文件夹' : '未命名.md',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '创建', value: 'ok', primary: true },
      ],
    }).then(function (result) {
      if (result.value !== 'ok') { return; }
      var name = (result.text || '').trim();
      if (!name) { return; }

      hostCall('fsNew', { dir: folder, name: name, folder: !!asFolder }).then(function (data) {
        renderFilePanel();
        if (data && data.dir === false) { openPath(data.path); }
        else { toast('已创建 ' + data.name); }
      }).catch(function (error) { toast(error.message, true); });
    });
  }

  function renameEntry(path) {
    if (!path) { return; }
    showDialog({
      title: '重命名',
      message: path,
      input: true,
      value: basename(path),
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '重命名', value: 'ok', primary: true },
      ],
    }).then(function (result) {
      if (result.value !== 'ok') { return; }
      var name = (result.text || '').trim();
      if (!name || name === basename(path)) { return; }

      hostCall('fsRename', { path: path, name: name }).then(function (data) {
        // 已打开的标签会继续跟随它原本指向的文件。
        var tab = state.tabs.find(function (item) {
          return item.path && item.path.toLowerCase() === path.toLowerCase();
        });
        if (tab && data && data.path) {
          tab.path = data.path;
          tab.name = data.name || basename(data.path);
          if (tab === activeTab()) { syncDocDirectory(tab); }
          renderTabs();
          updateWindowTitle();
        }
        renderFilePanel();
        toast('已重命名为 ' + (data && data.name ? data.name : name));
      }).catch(function (error) { toast(error.message, true); });
    });
  }

  function deleteEntry(path) {
    if (!path) { return; }
    showDialog({
      title: '删除',
      message: '「' + basename(path) + '」会被移到回收站。',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '移到回收站', value: 'ok', danger: true, primary: true },
      ],
    }).then(function (result) {
      if (result.value !== 'ok') { return; }

      hostCall('fsDelete', { path: path }).then(function () {
        // 先关闭指向该文件（或位于该文件夹内）的所有标签，
        // 这样待执行的保存不会把刚删除的内容重新创建出来。
        state.tabs.slice().forEach(function (tab) {
          if (tab.path && tab.path.toLowerCase().indexOf(path.toLowerCase()) === 0) {
            tab.dirty = false;
            dropTab(tab.id);
          }
        });
        renderFilePanel();
        toast('已移到回收站');
      }).catch(function (error) { toast(error.message, true); });
    });
  }

  // --------------------------------------------------------------- 设置

  function normalizeConfig(raw) {
    var config = raw || {};
    var themeOk = THEMES.some(function (item) { return item.id === config.theme; });
    config.theme = themeOk ? config.theme : 'paper';
    config.viewMode = EDIT_MODES.indexOf(config.viewMode) >= 0 ? config.viewMode : 'split';
    config.fontSize = clamp(config.fontSize || 16, 12, 26);
    config.lineHeight = clamp(config.lineHeight || 1.75, 1.3, 2.4);
    config.contentWidth = clamp(config.contentWidth || 900, 560, 1400);
    config.splitRatio = clamp(config.splitRatio || 0.5, 0.15, 0.85);
    // 微软雅黑是默认的编辑字体，其余字体需要用户自行选择。
    config.fontFamily = config.fontFamily || "'Microsoft YaHei UI','Microsoft YaHei',sans-serif";
    config.recent = config.recent || [];
    config.session = config.session || [];
    config.sessionActive = config.sessionActive || '';
    // 窗口是否置顶。窗口标志本身不会在重启后保留，
    // 因此把这个选择记在这里，并在启动时重新应用。
    config.topmost = config.topmost === true;
    config.sidebar = config.sidebar !== false;
    config.sidebarTab = config.sidebarTab || 'outline';
    // 查找栏被拖到的位置，下次启动时回到那里。
    config.findLeft = typeof config.findLeft === 'number' ? config.findLeft : null;
    config.findTop = typeof config.findTop === 'number' ? config.findTop : null;
    return config;
  }

  function applyConfig() {
    var config = state.config;
    var root = document.documentElement;

    // 字号和行高都保存在配置中，因此从这里开始，缓存的行高已经过期。
    forgetEditorLineHeight();

    root.dataset.theme = config.theme;
    root.dataset.mode = config.viewMode;
    root.dataset.gutter = config.showLineNumbers ? '1' : '0';

    root.style.setProperty('--edit-size', config.fontSize + 'px');
    root.style.setProperty('--edit-line', Math.round(config.fontSize * config.lineHeight) + 'px');
    root.style.setProperty('--content-width', config.contentWidth + 'px');
    // 使用编辑器自己的变量，这样在这里选择正文字体时，
    // 不会把预览中的代码块一起改掉。
    if (config.fontFamily) {
      root.style.setProperty('--font-editor', config.fontFamily);
    } else {
      root.style.removeProperty('--font-editor');
    }

    dom.app.classList.toggle('is-focus', !!config.focusMode);
    dom.sidebar.classList.toggle('is-hidden', !config.sidebar);
    // 专注模式开启时侧边栏是 display:none，因此按钮不能声称它正在显示；
    // 此时它反而充当退出专注模式的入口。
    dom.btnSidebar.classList.toggle('is-on', !!config.sidebar && !config.focusMode);
    dom.btnSidebar.title = config.focusMode
      ? '退出专注模式  (F8 / Esc)'
      : '切换侧边栏  (Ctrl+\\)';

    var theme = THEMES.find(function (item) { return item.id === config.theme; }) || THEMES[0];
    hostCall('background', { color: theme.chrome }).catch(function () {});

    applySplitRatio();

    Array.prototype.forEach.call(dom.viewSwitch.children, function (button) {
      button.classList.toggle('is-on', button.dataset.mode === config.viewMode);
    });

    dom.setFontSize.value = config.fontSize;
    dom.setLineHeight.value = Math.round(config.lineHeight * 100);
    dom.setContentWidth.value = config.contentWidth;
    syncRangeFills();
    dom.setFontFamily.value = config.fontFamily;
    dom.valFontSize.textContent = config.fontSize + ' px';
    dom.valLineHeight.textContent = config.lineHeight.toFixed(2);
    dom.valContentWidth.textContent = config.contentWidth + ' px';

    dom.setGutter.classList.toggle('is-on', !!config.showLineNumbers);
    dom.setTypewriter.classList.toggle('is-on', !!config.typewriter);
    dom.setFocus.classList.toggle('is-on', !!config.focusMode);
    dom.setAutoSave.classList.toggle('is-on', !!config.autoSave);

    dom.statusZoom.textContent = Math.round(config.fontSize / 16 * 100) + '%';

    updateStatusBar(true);
    renderHighlightNow();
  }

  var configTimer = 0;
  function saveConfig() {
    clearTimeout(configTimer);
    configTimer = setTimeout(function () {
      hostCall('config', { config: state.config }).catch(function () {});
    }, 400);
  }

  function setViewMode(mode) {
    var previous = document.documentElement.dataset.mode;
    // 切换前读取到的读者正在看的源码位置。即将显示的那个窗格宽度会变化，
    // 该位置之上的每一行都会重新折行——因此同一个滚动偏移量不再对应同一个地方，
    // 读者眼前的标题会滑到四分之一屏之外。
    var keep = previous === 'read' ? previewAnchorLine() : null;
    state.config.viewMode = mode;
    document.documentElement.dataset.mode = mode;
    Array.prototype.forEach.call(dom.viewSwitch.children, function (button) {
      button.classList.toggle('is-on', button.dataset.mode === mode);
    });
    applySplitRatio();
    updateStatusBar();
    saveConfig();
    if (mode !== 'edit' && previewStale) { renderPreview(); }

    // 进入分栏时，要把两个窗格对齐到读者原来的位置。此前屏幕上只有一个窗格，
    // 另一个还停在它上次被留的地方：从阅读模式出来时，编辑器可能与刚刚屏幕上的文字
    // 相隔整整一页，并且会一直如此，直到下一次滚动移动其中之一。
    // 原先可见的窗格主导——从阅读模式出来是预览，从编辑模式出来是编辑器——
    // 而定位会等一帧，好让新显示的窗格有布局可供测量。
    if (mode === 'split') {
      requestAnimationFrame(function () {
        if (document.documentElement.dataset.mode !== 'split') { return; }
        // 原先在屏幕上的窗格主导。从阅读模式出来时是预览：把它放回当时显示的那一行
        // ——按现在的宽度重新计算——再把编辑器带到那里。
        if (keep) { placePreviewOnLine(keep.line); syncEditorFromPreview(); }
        else { syncPreviewFromEditor(); }
      });
    }
  }

  /**
   * 分栏比例是一个内联的 grid-template-columns，它的优先级会压过编辑/阅读模式的
   * 单列规则，把唯一可见的窗格挤进第一条轨道。只要分栏不在屏幕上就要清除它。
   */
  function applySplitRatio() {
    if (document.documentElement.dataset.mode !== 'split') {
      dom.panes.style.gridTemplateColumns = '';
      relayoutEditor();
      return;
    }
    var left = Math.round(clamp(state.config.splitRatio, 0.15, 0.85) * 1000) / 10;
    dom.panes.style.gridTemplateColumns = left + '% 6px ' + (100 - left) + '%';
    relayoutEditor();
  }

  // ----------------------------------------------------------------- 面板

  /**
   * 选择侧边栏要显示哪个面板。
   *
   * `reveal` 区分“用户主动选了这个面板”和“恢复上次保存的状态”。没有这一区分，
   * 被收起的侧边栏每次启动都会弹回来，而选择面板又会让 `config.sidebar` 停留在旧值
   * ——于是下一次 applyConfig()（字号、主题、专注模式）就会让它在会话中途消失。
   */
  function selectSidebarPanel(panel, reveal) {
    state.config.sidebarTab = panel;
    if (reveal) { state.config.sidebar = true; }

    dom.sidebar.classList.toggle('is-hidden', !state.config.sidebar);
    dom.btnSidebar.classList.toggle('is-on', !!state.config.sidebar);

    Array.prototype.forEach.call(dom.activity.querySelectorAll('.abtn[data-panel]'), function (button) {
      button.classList.toggle('is-on', button.dataset.panel === panel);
    });
    Array.prototype.forEach.call(dom.sidebar.querySelectorAll('.panel'), function (node) {
      node.classList.toggle('is-on', node.dataset.panel === panel);
    });

    if (panel === 'files') { renderFilePanel(); }
    if (panel === 'settings') { buildThemeGrid(); }
    relayoutEditor();
    saveConfig();
  }

  function toggleSidebar() {
    // 专注模式用 display:none 隐藏侧边栏，其优先级高于这个按钮切换的类——
    // 因此这次点击只能理解为“退出专注模式”。
    if (state.config.focusMode) {
      exitFocusMode(true);
      return;
    }

    state.config.sidebar = !state.config.sidebar;
    dom.sidebar.classList.toggle('is-hidden', !state.config.sidebar);
    dom.btnSidebar.classList.toggle('is-on', state.config.sidebar);
    if (state.config.sidebar && state.config.sidebarTab === 'settings') { buildThemeGrid(); }
    relayoutEditor();
    saveConfig();
  }

  function exitFocusMode(revealSidebar) {
    if (!state.config.focusMode) { return; }

    state.config.focusMode = false;
    if (revealSidebar) { state.config.sidebar = true; }

    applyConfig();
    saveConfig();
    toast('已退出专注模式');
  }

  // --------------------------------------------------------------- 弹出面板

  function themeSwatchesHtml() {
    return THEMES.map(function (theme) {
      return '<button class="theme-swatch' + (theme.id === state.config.theme ? ' is-on' : '') +
        '" data-theme="' + theme.id + '"><span class="dots">' +
        theme.swatch.map(function (color) {
          return '<i style="background:' + color + '"></i>';
        }).join('') + '</span><span>' + theme.name + '</span></button>';
    }).join('');
  }

  function themeGridHtml() {
    return '<div class="theme-grid">' + themeSwatchesHtml() + '</div>';
  }

  /** 设置面板另有一份色块副本。 */
  function buildThemeGrid() {
    if (dom.themeGrid) { dom.themeGrid.innerHTML = themeSwatchesHtml(); }
  }

  function setTheme(id) {
    state.config.theme = id;
    applyConfig();
    saveConfig();
    buildThemeGrid();
  }

  function buildThemePopover() {
    dom.themePopover.innerHTML = '<div class="group-label">界面主题</div>' + themeGridHtml();
  }

  function buildTablePopover() {
    dom.tablePopover.innerHTML =
      '<div class="group-label">行</div>' +
      '<button class="menu-item" data-table="rowAbove">在上方插入行</button>' +
      '<button class="menu-item" data-table="rowBelow">在下方插入行</button>' +
      '<button class="menu-item" data-table="rowDelete">删除当前行</button>' +
      '<div class="group-label">列</div>' +
      '<button class="menu-item" data-table="columnLeft">在左侧插入列</button>' +
      '<button class="menu-item" data-table="columnRight">在右侧插入列</button>' +
      '<button class="menu-item" data-table="columnDelete">删除当前列</button>' +
      '<div class="group-label">对齐</div>' +
      '<button class="menu-item" data-table="alignLeft">左对齐</button>' +
      '<button class="menu-item" data-table="alignCenter">居中</button>' +
      '<button class="menu-item" data-table="alignRight">右对齐</button>';
  }

  function buildImagePopover() {
    dom.imagePopover.innerHTML =
      '<button class="menu-item" data-image="file"><svg class="icon icon-sm"><use href="#i-image"/></svg>' +
      '插入本地图片<span class="shortcut">Ctrl+Shift+I</span></button>' +
      '<button class="menu-item" data-image="url"><svg class="icon icon-sm"><use href="#i-link"/></svg>' +
      '从网址下载并插入</button>' +
      '<div class="group-label">当前行的图片</div>' +
      '<button class="menu-item" data-image="left">左对齐</button>' +
      '<button class="menu-item" data-image="center">居中</button>' +
      '<button class="menu-item" data-image="right">右对齐</button>' +
      '<button class="menu-item" data-image="">恢复默认</button>';
  }

  function buildExportPopover() {
    dom.exportPopover.innerHTML =
      '<button class="menu-item" data-export="html"><svg class="icon icon-sm"><use href="#i-export"/></svg>' +
      '导出为 HTML<span class="shortcut">Ctrl+Shift+E</span></button>' +
      '<button class="menu-item" data-export="pdf"><svg class="icon icon-sm"><use href="#i-pdf"/></svg>' +
      '导出为 PDF<span class="shortcut">Ctrl+Shift+P</span></button>' +
      '<button class="menu-item" data-export="text"><svg class="icon icon-sm"><use href="#i-write"/></svg>' +
      '导出为纯文本</button>' +
      '<button class="menu-item" data-export="rtf"><svg class="icon icon-sm"><use href="#i-export"/></svg>' +
      '导出为 Word (.rtf)</button>' +
      '<button class="menu-item" data-export="image"><svg class="icon icon-sm"><use href="#i-image"/></svg>' +
      '导出为长图 (.png)</button>' +
      '<div class="menu-sep"></div>' +
      '<button class="menu-item" data-export="print"><svg class="icon icon-sm"><use href="#i-pdf"/></svg>' +
      '打印<span class="shortcut">Ctrl+P</span></button>' +
      '<button class="menu-item" data-export="rich"><svg class="icon icon-sm"><use href="#i-copy"/></svg>' +
      '复制为富文本</button>' +
      '<button class="menu-item" data-export="copy"><svg class="icon icon-sm"><use href="#i-copy"/></svg>' +
      '复制 HTML 源码</button>' +
      '<button class="menu-item" data-export="reveal"><svg class="icon icon-sm"><use href="#i-folder"/></svg>' +
      '在资源管理器中显示</button>';
  }

  function togglePopover(node, anchor) {
    var visible = node.classList.contains('is-on');
    closePopovers();
    if (visible) { return; }

    node.classList.add('is-on');
    if (anchor) { anchor.classList.add('is-on'); }
    var rect = anchor.getBoundingClientRect();
    var left = Math.min(window.innerWidth - node.offsetWidth - 10, Math.max(10, rect.right - node.offsetWidth));
    node.style.left = left + 'px';
    node.style.top = (rect.bottom + 6) + 'px';
  }

  function closePopovers() {
    dom.themePopover.classList.remove('is-on');
    dom.exportPopover.classList.remove('is-on');
    dom.tablePopover.classList.remove('is-on');
    dom.imagePopover.classList.remove('is-on');
    dom.ctxmenu.classList.remove('is-on');
    // 这些按钮表示各自的面板是否打开，因此面板关闭时它们也要一起复位。
    [dom.btnTheme, dom.btnExport, dom.btnTableTools, dom.btnImage].forEach(function (button) {
      if (button) { button.classList.remove('is-on'); }
    });
  }

  // -------------------------------------------------------------- 导出

  var APP_SELECTOR = /^\.(app|titlebar|brand|tb-|ibtn|segmented|win-buttons|activity|sidebar|panel|empty-hint|outline-item|tree-|recent-|field|switch|main|tabs|tab|toolbar|panes|pane|splitter|scroll|page|hl|editor|preview-scroll|statusbar|findbar|popover|group-label|theme-|menu-|ctxmenu|modal|shortcut|toast|src-line|lnum|md-hit)/;

  function collectStyles() {
    var parts = [];
    Array.prototype.forEach.call(document.styleSheets, function (sheet) {
      try {
        Array.prototype.forEach.call(sheet.cssRules, function (rule) {
          if (rule.selectorText) {
            var selectors = rule.selectorText.split(',').map(function (text) { return text.trim(); });
            var keep = selectors.some(function (text) { return text.indexOf('.md') === 0; });
            var drop = selectors.every(function (text) { return APP_SELECTOR.test(text); });
            if (drop && !keep) { return; }
          }
          parts.push(rule.cssText);
        });
      } catch (error) { /* 我们自带的样式表总是可读的 */ }
    });

    return parts.join('\n') +
      '\nbody.mn-export{background:var(--paper);padding:48px 0;}\n' +
      'body.mn-export .md{max-width:820px;margin:0 auto;}\n';
  }

  function exportHtml() {
    var doc = buildExportDocument();
    if (!doc) { return; }

    hostCall('exportHtml', { html: doc.html, suggested: doc.title + '.html' }).then(function (data) {
      if (!data || data.canceled) { return; }
      toast('已导出 ' + data.name);
    }).catch(function (error) { toast(error.message, true); });
  }

  /** 构建 HTML 与 PDF 导出共用的独立文档。 */
  function buildExportDocument() {
    var tab = activeTab();
    if (!tab) { return null; }
    // 导出读取的是渲染后的 HTML，而源码模式会让它处于过期状态。
    if (previewStale) { renderPreview(true); }

    var title = tab.path ? basename(tab.path).replace(/\.[^.]+$/, '') : '未命名';
    var html = '<!DOCTYPE html>\n<html lang="zh-CN" data-theme="' + state.config.theme + '">\n<head>\n' +
      '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + esc(title) + '</title>\n<style>\n' + collectStyles() + '\n</style>\n</head>\n' +
      '<body class="mn-export">\n<article class="md">\n' + (tab.renderedHtml || '') +
      '\n</article>\n</body>\n</html>';

    return { title: title, html: html };
  }

  function exportPdf(targetPath) {
    var doc = buildExportDocument();
    if (!doc) { return Promise.resolve(null); }

    // 导出 PDF 要请 WebView2 打印页面，因此它的前置条件与打印相同：
    // 每个块都必须真正绘制出来。
    drawAllPreviewBlocks();
    return hostCall('exportPdf', {
      suggested: doc.title + '.pdf',
      path: typeof targetPath === 'string' ? targetPath : '',
    }).then(function (data) {
      layoutPreview();
      if (data && data.path) { toast('已导出 ' + data.name); }
      return data;
    }).catch(function (error) {
      layoutPreview();
      toast(error.message, true);
      return null;
    });
  }

  function copyHtmlSource() {
    var tab = activeTab();
    if (!tab) { return; }
    if (previewStale) { renderPreview(true); }
    navigator.clipboard.writeText(tab.renderedHtml || '').then(function () {
      toast('HTML 已复制到剪贴板');
    }).catch(function () { toast('复制失败', true); });
  }

  // ----------------------------------------------------- 其他导出格式

  /** 把 Markdown 简化为可读文本：标记去掉，文字保留。 */
  function toPlainText(markdown) {
    return String(markdown == null ? '' : markdown)
      .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
      .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
      .replace(/^ {0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^ {0,3}>[ \t]?/gm, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)(\{[^}\n]*\})?/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^ {0,3}[-*+][ \t]+\[[ xX]\][ \t]+/gm, '\u25a1 ')
      .replace(/^ {0,3}[-*+][ \t]+/gm, '\u2022 ')
      .replace(/^ {0,3}[\s:|-]*-[\s:|-]*$/gm, '')
      .replace(/[*_~`=]/g, '')
      .replace(/\|/g, '  ')
      .replace(/<[^>]*>/g, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '') + '\n';
  }

  function exportText() {
    var tab = activeTab();
    if (!tab) { return; }
    var suggested = (tab.path ? basename(tab.path).replace(/\.[^.]+$/, '') : '未命名') + '.txt';

    hostCall('exportFile', {
      text: toPlainText(tab.text),
      suggested: suggested,
      filter: '*.txt',
    }).then(function (data) {
      if (data && data.name) { toast('已导出 ' + data.name); }
    }).catch(function (error) { toast(error.message, true); });
  }

  // ------------------------------------------------------------------- RTF

  function rtfEscape(text) {
    return String(text == null ? '' : text)
      .replace(/\\/g, '\\\\')
      .replace(/[{}]/g, function (ch) { return '\\' + ch; })
      .replace(/[\u0080-\uffff]/g, function (ch) {
        var code = ch.charCodeAt(0);
        return '\\u' + (code > 32767 ? code - 65536 : code) + '?';
      })
      .replace(/\r?\n/g, '\\line ');
  }

  function rtfInline(node) {
    var out = '';
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === Node.TEXT_NODE) { out += rtfEscape(child.nodeValue); return; }
      if (child.nodeType !== Node.ELEMENT_NODE) { return; }

      var tag = child.localName;
      if (tag === 'strong' || tag === 'b') { out += '\\b ' + rtfInline(child) + '\\b0 '; return; }
      if (tag === 'em' || tag === 'i') { out += '\\i ' + rtfInline(child) + '\\i0 '; return; }
      if (tag === 'del' || tag === 's') { out += '\\strike ' + rtfInline(child) + '\\strike0 '; return; }
      if (tag === 'mark') { out += '\\highlight1 ' + rtfInline(child) + '\\highlight0 '; return; }
      if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') {
        out += '\\f1 ' + rtfEscape(child.textContent) + '\\f0 ';
        return;
      }
      if (tag === 'sub') { out += '\\sub ' + rtfInline(child) + '\\nosupersub '; return; }
      if (tag === 'sup') { out += '\\super ' + rtfInline(child) + '\\nosupersub '; return; }
      if (tag === 'br') { out += '\\line '; return; }
      if (tag === 'img') { out += rtfEscape('[图片: ' + (child.getAttribute('alt') || '') + ']'); return; }
      if (tag === 'math') { out += rtfEscape(child.textContent); return; }
      out += rtfInline(child);
    });
    return out;
  }

  function rtfBlocks(root, depth) {
    depth = depth || 0;
    var out = '';

    Array.prototype.forEach.call(root.childNodes, function (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue.trim()) { out += rtfEscape(node.nodeValue); }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) { return; }

      var tag = node.localName;
      if (tag === 'script' || tag === 'style') { return; }

      if (/^h[1-6]$/.test(tag)) {
        var size = { h1: 44, h2: 36, h3: 30, h4: 26, h5: 24, h6: 22 }[tag];
        out += '\\pard\\sb240\\sa120\\b\\fs' + size + ' ' + rtfInline(node) + '\\b0\\fs22\\par\n';
        return;
      }
      if (tag === 'p') { out += '\\pard ' + rtfInline(node) + '\\par\n'; return; }
      if (tag === 'blockquote') {
        out += '\\pard\\li720\\ri360\\i ' + rtfInline(node) + '\\i0\\par\n';
        return;
      }
      if (tag === 'pre') {
        out += '\\pard\\f1\\fs18 ' + rtfEscape(node.textContent.replace(/\n$/, '')) + '\\f0\\fs22\\par\n';
        return;
      }
      if (tag === 'hr') { out += '\\pard\\brdrb\\brdrs\\brdrw10\\par\n'; return; }
      if (tag === 'li') {
        out += '\\pard\\fi-240\\li' + (360 + depth * 360) + ' \\bullet\\tab ' + rtfInline(node) + '\\par\n';
        return;
      }
      if (tag === 'table') {
        Array.prototype.forEach.call(node.querySelectorAll('tr'), function (row) {
          var cells = [];
          Array.prototype.forEach.call(row.children, function (cell) {
            cells.push(rtfInline(cell));
          });
          out += '\\pard ' + cells.join('\\tab ') + '\\par\n';
        });
        out += '\\pard\\par\n';
        return;
      }
      if (tag === 'ul' || tag === 'ol') {
        out += rtfBlocks(node, depth);
        out += '\\pard\\par\n';
        return;
      }
      if (tag === 'figure') {
        var image = node.querySelector('img');
        out += '\\pard ' + rtfEscape('[图片: ' + (image ? image.getAttribute('alt') || '' : '') + ']') + '\\par\n';
        var caption = node.querySelector('figcaption');
        if (caption) { out += '\\pard\\i ' + rtfInline(caption) + '\\i0\\par\n'; }
        return;
      }
      if (tag === 'img') {
        out += '\\pard ' + rtfEscape('[图片: ' + (node.getAttribute('alt') || '') + ']') + '\\par\n';
        return;
      }
      if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'details' ||
          tag === 'dd' || tag === 'dt' || tag === 'dl' || tag === 'nav' || tag === 'figure') {
        out += rtfBlocks(node, depth + (tag === 'dd' ? 1 : 0));
        return;
      }
      out += '\\pard ' + rtfInline(node) + '\\par\n';
    });

    return out;
  }

  function buildRtf() {
    var tab = activeTab();
    if (!tab) { return ''; }

    return '{\\rtf1\\ansi\\ansicpg936\\deff0' +
      '{\\fonttbl{\\f0\\fnil\\fcharset134 Microsoft YaHei;}{\\f1\\fmodern Consolas;}}' +
      '{\\colortbl;\\red176\\green125\\blue43;}' +
      '\\viewkind4\\uc1\\f0\\fs22\n' +
      rtfBlocks(dom.preview) + '}\n';
  }

  function exportRtf() {
    var tab = activeTab();
    if (!tab) { return; }
    var suggested = (tab.path ? basename(tab.path).replace(/\.[^.]+$/, '') : '未命名') + '.rtf';

    hostCall('exportFile', {
      text: buildRtf(),
      suggested: suggested,
      filter: '*.rtf',
    }).then(function (data) {
      if (data && data.name) { toast('已导出 ' + data.name + '（Word 可直接打开）'); }
    }).catch(function (error) { toast(error.message, true); });
  }

  // -------------------------------------------------------------- 长图

  /** 把导出内容中的每个 <img> 转成 data URL，以免污染画布。 */
  function inlineImages(clone) {
    var images = Array.prototype.slice.call(clone.querySelectorAll('img'));
    return Promise.all(images.map(function (image) {
      var source = image.getAttribute('src') || '';
      if (!source || source.indexOf('data:') === 0) { return Promise.resolve(); }

      return fetch(source).then(function (response) {
        if (!response.ok) { return null; }
        return response.blob();
      }).then(function (blob) {
        if (!blob) { return null; }
        return new Promise(function (resolve) {
          var reader = new FileReader();
          reader.onload = function () { resolve(String(reader.result)); };
          reader.onerror = function () { resolve(null); };
          reader.readAsDataURL(blob);
        });
      }).then(function (dataUrl) {
        if (dataUrl) { image.setAttribute('src', dataUrl); }
      }).catch(function () { /* 保留占位符，暂时代替该图片 */ });
    }));
  }

  // 画布（以及 SVG 图像）在 32767 设备像素处会截断，而一次性把整篇笔记栅格化远在
  // 到达这个上限之前就已经非常慢，因此页面按切片绘制再拼接。
  // 超过高度限制的文档会缩放到适合大小，而不是悄悄返回空白——直接用 toDataURL()
  // 就是这种结果。
  var LONG_IMAGE_MAX_HEIGHT = 30000;
  var LONG_IMAGE_SLICE = 2000;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XHTML_NS = 'http://www.w3.org/1999/xhtml';

  function loadImage(source) {
    return new Promise(function (resolve, reject) {
      var element = new Image();
      element.onload = function () { resolve(element); };
      element.onerror = function () { reject(new Error('图片渲染失败')); };
      element.src = source;
    });
  }

  /** 与页面背景不同的采样像素所占比例。 */
  function imageInk(context, width, height, background) {
    var sample = document.createElement('canvas');
    sample.width = Math.min(width, 240);
    sample.height = 1;
    var sampleContext = sample.getContext('2d');
    var rows = Math.min(48, height);
    var ink = 0;
    var total = 0;

    for (var i = 0; i < rows; i++) {
      var y = Math.min(height - 1, Math.round(i * height / rows));
      sampleContext.clearRect(0, 0, sample.width, 1);
      sampleContext.drawImage(context.canvas, 0, y, width, 1, 0, 0, sample.width, 1);
      var pixels = sampleContext.getImageData(0, 0, sample.width, 1).data;
      for (var x = 0; x < pixels.length; x += 4) {
        total++;
        var distance = Math.abs(pixels[x] - background[0]) + Math.abs(pixels[x + 1] - background[1]) +
          Math.abs(pixels[x + 2] - background[2]);
        if (distance > 24) { ink++; }
      }
    }
    return total ? ink / total : 0;
  }

  function parseRgb(text, fallback) {
    var match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(text || ''));
    if (!match) { return fallback; }
    return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
  }

  /**
   * 文档的一个纵向切片，以 SVG 字符串表示。
   *
   * 刻意用真实 DOM 节点构建并通过 XMLSerializer 序列化：渲染出的标记中含有 HTML
   * 空元素（`<br>`、`<hr>`、`<img>`、`<input>`），而手写的 SVG 是 XML——
   * 这些标签没有自闭合时浏览器会拒绝解析，这正是过去遇到的“图片渲染失败”。
   * 序列化同时还会转义样式表中任何棘手的字符。
   */
  function buildSliceSvg(content, styles, geometry) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('width', geometry.width);
    svg.setAttribute('height', geometry.height);

    var foreign = document.createElementNS(SVG_NS, 'foreignObject');
    foreign.setAttribute('x', 0);
    foreign.setAttribute('y', 0);
    foreign.setAttribute('width', geometry.width);
    foreign.setAttribute('height', geometry.height);

    var frame = document.createElementNS(XHTML_NS, 'div');
    frame.setAttribute('style', 'position:relative;width:' + geometry.width +
      'px;height:' + geometry.height + 'px;overflow:hidden;background:' + geometry.background + ';' +
      themeVariables(styles));

    var style = document.createElementNS(XHTML_NS, 'style');
    style.textContent = styles;
    frame.appendChild(style);

    var shifted = document.createElementNS(XHTML_NS, 'div');
    shifted.setAttribute('style', 'position:absolute;left:0;top:' + (-geometry.top) +
      'px;width:' + geometry.width + 'px;');

    var article = document.createElementNS(XHTML_NS, 'article');
    article.setAttribute('class', 'md');
    article.setAttribute('style', 'max-width:none;padding:32px 34px;');
    Array.prototype.forEach.call(content.childNodes, function (child) {
      article.appendChild(child.cloneNode(true));
    });

    shifted.appendChild(article);
    frame.appendChild(shifted);
    foreign.appendChild(frame);
    svg.appendChild(foreign);

    return new XMLSerializer().serializeToString(svg);
  }

  /**
   * 把主题调色板写成内联声明。
   *
   * 样式表确实会进入图片（下面会内联），但其中的 `:root` 指向 SVG 元素本身，
   * 于是各条规则依赖的自定义属性全都解析不到值——代码卡片、表格边框和分隔线都失去了
   * 样式，`border: 1px solid var(--border)` 更是直接消失。因此把样式表提及的每个变量
   * 都复制到外层包裹元素上，由内容继承。
   */
  function themeVariables(styles) {
    var computed = getComputedStyle(document.documentElement);
    var seen = {};
    var declarations = '';

    (styles || collectStyles()).replace(/--([a-z0-9-]+)\s*:/gi, function (all, name) {
      if (seen[name]) { return all; }
      seen[name] = true;
      var value = computed.getPropertyValue('--' + name).trim();
      if (value) { declarations += '--' + name + ':' + value + ';'; }
      return all;
    });
    return declarations;
  }

  async function exportLongImage(targetPath) {
    var tab = activeTab();
    if (!tab) { return null; }
    if (previewStale) { renderPreview(true); }
    if (!tab.renderedHtml) {
      toast('还没有可导出的内容', true);
      return null;
    }

    var rootStyle = getComputedStyle(document.documentElement);
    var width = Math.round(clamp(state.config.contentWidth + 68, 640, 1400));
    var background = rootStyle.getPropertyValue('--paper').trim() || '#ffffff';
    var styles = collectStyles();

    // 测量用的节点与进入图片的标记完全一致：同样的宽度、同样的内边距，
    // 不做 max-width 限制。
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:absolute;left:-20000px;top:0;width:' + width + 'px;';
    var article = document.createElement('article');
    article.className = 'md';
    article.style.cssText = 'max-width:none;padding:32px 34px;background:' + background + ';';
    article.innerHTML = tab.renderedHtml;
    wrapper.appendChild(article);
    document.body.appendChild(wrapper);

    var result = null;
    try {
      await inlineImages(article);
      var fullHeight = Math.max(200, Math.ceil(wrapper.getBoundingClientRect().height));

      var scale = Math.min(1, LONG_IMAGE_MAX_HEIGHT / fullHeight);
      var outWidth = Math.max(1, Math.round(width * scale));
      var outHeight = Math.max(1, Math.round(fullHeight * scale));

      var canvas = document.createElement('canvas');
      canvas.width = outWidth;
      canvas.height = outHeight;
      var context = canvas.getContext('2d');
      context.fillStyle = background;
      context.fillRect(0, 0, outWidth, outHeight);

      // 图片此时已是 data URL；主动解码可以避免它们在 foreignObject 内部落入
      // “惰性加载、永远不在视口内”的陷阱。
      Array.prototype.forEach.call(article.querySelectorAll('img'), function (image) {
        image.setAttribute('loading', 'eager');
      });
      var contentNode = article.cloneNode(true);

      for (var top = 0; top < fullHeight; top += LONG_IMAGE_SLICE) {
        var height = Math.min(LONG_IMAGE_SLICE, fullHeight - top);
        var svg = buildSliceSvg(contentNode, styles, {
          width: width, height: height, top: top, background: background,
        });

        var image = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
        context.drawImage(image, 0, Math.round(top * scale), outWidth, Math.round(height * scale));
      }

      var ink = imageInk(context, outWidth, outHeight, parseRgb(background, [255, 255, 255]));
      var dataUrl = canvas.toDataURL('image/png');
      var base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      var suggested = (tab.path ? basename(tab.path).replace(/\.[^.]+$/, '') : '未命名') + '.png';

      var data = await hostCall('exportFile', {
        base64: base64,
        suggested: suggested,
        filter: '*.png',
        path: typeof targetPath === 'string' ? targetPath : '',
      });

      result = {
        path: data && data.path,
        name: data && data.name,
        width: outWidth,
        height: outHeight,
        scaled: scale,
        ink: ink,
      };

      if (ink < 0.002) {
        toast('长图内容为空，请换一份文档再试', true);
      } else if (data && data.name) {
        toast('已导出长图 ' + data.name + '（' + outWidth + '×' + outHeight + '）');
      }
    } catch (error) {
      toast('长图导出失败：' + error.message, true);
    } finally {
      wrapper.remove();
    }

    return result;
  }

  // ------------------------------------------------------------- 关闭流程

  function requestClose() {
    if (state.closing) { return; }

    var dirty = state.tabs.filter(function (tab) { return tab.dirty; });
    if (!dirty.length) {
      state.closing = true;
      hostCall('window', { action: 'close' }).catch(function () {});
      return;
    }

    var names = dirty.map(function (tab) { return '· ' + tabTitle(tab); }).join('\n');
    showDialog({
      title: '未保存的修改',
      message: '以下文件有未保存的修改：\n\n' + names,
      buttons: saveChoices('退出'),
    }).then(function (choice) {
      if (choice.value === 'cancel') { return; }

      if (choice.value === 'discard') {
        state.closing = true;
        hostCall('window', { action: 'close' }).catch(function () {});
        return;
      }

      Promise.all(dirty.map(saveTabForClose)).then(function (outcomes) {
        if (outcomes.some(function (ok) { return !ok; })) { return; }
        state.closing = true;
        hostCall('window', { action: 'close' }).catch(function () {});
      });
    });
  }

  // ------------------------------------------------------------ 右键菜单

  function showContextMenu(x, y, items) {
    dom.ctxmenu.innerHTML = items.map(function (item) {
      if (item === '---') { return '<div class="menu-sep"></div>'; }
      return '<button class="menu-item" data-key="' + item.key + '">' + esc(item.label) +
        (item.shortcut ? '<span class="shortcut">' + esc(item.shortcut) + '</span>' : '') + '</button>';
    }).join('');

    dom.ctxmenu.classList.add('is-on');
    dom.ctxmenu.style.left = Math.min(x, window.innerWidth - dom.ctxmenu.offsetWidth - 8) + 'px';
    dom.ctxmenu.style.top = Math.min(y, window.innerHeight - dom.ctxmenu.offsetHeight - 8) + 'px';

    Array.prototype.forEach.call(dom.ctxmenu.querySelectorAll('.menu-item'), function (button) {
      button.addEventListener('click', function () {
        closePopovers();
        var entry = items.find(function (item) {
          return item !== '---' && item.key === button.dataset.key;
        });
        if (entry && entry.run) { entry.run(); }
      });
    });
  }

  function editorContextMenu(event) {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      { key: 'undo', label: '撤销', shortcut: 'Ctrl+Z', run: undo },
      { key: 'redo', label: '重做', shortcut: 'Ctrl+Y', run: redo },
      '---',
      { key: 'cut', label: '剪切', shortcut: 'Ctrl+X', run: function () {
        document.execCommand('cut');
        commitEdit(null, null, true);
      } },
      { key: 'copy', label: '复制', shortcut: 'Ctrl+C', run: function () { document.execCommand('copy'); } },
      { key: 'paste', label: '粘贴', shortcut: 'Ctrl+V', run: pasteFromClipboard },
      '---',
      { key: 'bold', label: '加粗', shortcut: 'Ctrl+B', run: function () { ACTIONS.bold(); } },
      { key: 'code', label: '行内代码', shortcut: 'Ctrl+`', run: function () { ACTIONS.code(); } },
      { key: 'link', label: '插入链接', shortcut: 'Ctrl+K', run: insertLink },
      '---',
      { key: 'selectall', label: '全选', shortcut: 'Ctrl+A', run: function () {
        dom.editor.focus();
        dom.editor.select();
      } },
      { key: 'find', label: '查找替换', shortcut: 'Ctrl+F', run: openFind },
      { key: 'reveal', label: '在资源管理器中显示', run: function () {
        var tab = activeTab();
        if (tab && tab.path) { hostCall('reveal', { path: tab.path }); }
      } },
    ]);
  }

  function pasteFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      toast('请使用 Ctrl+V 粘贴', true);
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      if (!text) { return; }
      dom.editor.focus();
      var start = dom.editor.selectionStart;
      dom.editor.setRangeText(text, start, dom.editor.selectionEnd, 'end');
      commitEdit(start + text.length, start + text.length, true);
    }).catch(function () { toast('剪贴板读取被拒绝，请直接按 Ctrl+V', true); });
  }

  function previewContextMenu(event) {
    event.preventDefault();
    showContextMenu(event.clientX, event.clientY, [
      { key: 'copy', label: '复制选中内容', run: function () { document.execCommand('copy'); } },
      { key: 'selectall', label: '全选', run: function () {
        var range = document.createRange();
        range.selectNodeContents(dom.preview);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } },
      '---',
      { key: 'rich', label: '复制为富文本', run: copyRichText },
      { key: 'html', label: '导出为 HTML', run: exportHtml },
      { key: 'pdf', label: '导出为 PDF', run: exportPdf },
      { key: 'print', label: '打印', shortcut: 'Ctrl+P', run: printDocument },
      { key: 'copyhtml', label: '复制 HTML 源码', run: copyHtmlSource },
    ]);
  }

  // ---------------------------------------------------------- 插入辅助

  function insertLink() {
    var start = dom.editor.selectionStart;
    var end = dom.editor.selectionEnd;
    var selected = dom.editor.value.slice(start, end);

    showDialog({
      title: '插入链接',
      message: selected ? '为选中的文字「' + selected + '」添加链接' : '输入链接地址',
      input: true,
      value: 'https://',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '插入', value: 'ok', primary: true },
      ],
    }).then(function (result) {
      if (result.value !== 'ok') { return; }
      var url = (result.text || '').trim();
      if (!url || url === 'https://') { return; }

      var label = selected || url.replace(/^https?:\/\//, '');
      var snippet = '[' + label + '](' + url + ')';
      dom.editor.focus();
      dom.editor.setRangeText(snippet, start, end, 'end');
      commitEdit(start + snippet.length, start + snippet.length, true);
    });
  }

  function insertImage() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', function () {
      if (input.files && input.files[0]) { insertImageFromFile(input.files[0]); }
    });
    input.click();
  }

  function insertTable() {
    insertBlock([
      '| 列 1 | 列 2 | 列 3 |',
      '| :--- | :---: | ---: |',
      '| 内容 | 内容 | 内容 |',
      '| 内容 | 内容 | 内容 |',
    ].join('\n'));
  }

  function insertMath() {
    var selected = dom.editor.value.slice(dom.editor.selectionStart, dom.editor.selectionEnd);
    if (selected && selected.indexOf('\n') < 0) {
      wrapSelection('$', '$', 'E = mc^2');
    } else {
      insertBlock('$$\nE = mc^2\n$$');
    }
  }

  function defaultFenceLanguage() {
    var parts = dom.editor.value.slice(0, dom.editor.selectionStart).split('\n');
    var line = parts[parts.length - 1] || '';
    if (/^\s*(color|background|rgba|\.\w+\s*\{|@media)/.test(line)) { return 'css'; }
    if (/^\s*</.test(line)) { return 'html'; }
    if (/^\s*(select|from|insert|update|create)\b/i.test(line)) { return 'sql'; }
    if (/^\s*(import|def|class|print\()/.test(line)) { return 'python'; }
    return '';
  }

  // --------------------------------------------------------------- 命令

  var ACTIONS = {
    bold: function () { wrapSelection('**', '**', '加粗文本'); },
    italic: function () { wrapSelection('*', '*', '斜体文本'); },
    strike: function () { wrapSelection('~~', '~~', '删除线'); },
    mark: function () { wrapSelection('==', '==', '高亮'); },
    code: function () { wrapSelection('`', '`', 'code'); },
    codeblock: function () {
      var selected = dom.editor.value.slice(dom.editor.selectionStart, dom.editor.selectionEnd);
      var language = defaultFenceLanguage();
      if (selected) {
        wrapSelection('```' + language + '\n', '\n```', '');
      } else {
        insertBlock('```' + language + '\n\n```');
      }
    },
    h1: function () { toggleHeading(1); },
    h2: function () { toggleHeading(2); },
    h3: function () { toggleHeading(3); },
    quote: function () { togglePrefix('quote'); },
    ul: function () { togglePrefix('ul'); },
    ol: function () { togglePrefix('ol'); },
    task: function () { togglePrefix('task'); },
    table: insertTable,
    rowAbove: function () { tableOp('rowAbove'); },
    rowBelow: function () { tableOp('rowBelow'); },
    rowDelete: function () { tableOp('rowDelete'); },
    columnLeft: function () { tableOp('columnLeft'); },
    columnRight: function () { tableOp('columnRight'); },
    columnDelete: function () { tableOp('columnDelete'); },
    alignLeft: function () { tableOp('alignLeft'); },
    alignCenter: function () { tableOp('alignCenter'); },
    alignRight: function () { tableOp('alignRight'); },
    link: insertLink,
    image: insertImage,
    imageUrl: insertImageFromUrl,
    math: insertMath,
    hr: function () { insertBlock('---'); },
    undo: undo,
    redo: redo,
  };

  function bumpZoom(direction) {
    state.config.fontSize = clamp(state.config.fontSize + direction, 12, 26);
    applyConfig();
    saveConfig();
  }

  function continueList(event) {
    var value = dom.editor.value;
    var caret = dom.editor.selectionStart;
    var lineStart = value.lastIndexOf('\n', caret - 1) + 1;
    var line = value.slice(lineStart, caret);
    var match = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (!match) { return; }

    event.preventDefault();

    if (!match[5].trim()) {
      dom.editor.setRangeText('', lineStart, caret, 'end');
      commitEdit(lineStart, lineStart, true);
      return;
    }

    var marker = match[2];
    if (/\d/.test(marker)) { marker = (parseInt(marker, 10) + 1) + marker.slice(-1); }
    var task = match[4] ? '[ ] ' : '';
    var insert = '\n' + match[1] + marker + match[3] + task;
    dom.editor.setRangeText(insert, caret, dom.editor.selectionEnd, 'end');
    commitEdit(caret + insert.length, caret + insert.length, true);
  }

  function toggleSetting(key) {
    state.config[key] = !state.config[key];
    applyConfig();
    saveConfig();
    if (key === 'typewriter' && state.config.typewriter) { typewriterFollow(); }
  }

  // ---------------------------------------------------------- 自动配对
  //
  // Typora 风格的配对：输入起始符号会插入配对的结束符号并把光标留在两者之间，
  // 在已有结束符号前输入结束符号则会跳过它。标记字符只在词边界处配对，
  // 因此 `snake_case` 和 `2*3=6` 仍保持纯文本的行为。

  var PAIR_OPENERS = {
    '(': ')', '[': ']', '{': '}', '`': '`', '*': '*', '_': '_',
    '~': '~', '=': '=', '$': '$', '"': '"', "'": "'",
  };
  var PAIR_CLOSERS = { ')': '(', ']': '[', '}': '{' };
  var PAIR_WORD_SENSITIVE = { '*': 1, _: 1, '~': 1, '=': 1, '$': 1, '"': 1, "'": 1 };

  function isWordCharAt(text, index) {
    if (index < 0 || index >= text.length) { return false; }
    return /[\w\u3400-\u9fff]/.test(text.charAt(index));
  }

  function autoPair(event) {
    var key = event.key;
    var start = dom.editor.selectionStart;
    var end = dom.editor.selectionEnd;
    var value = dom.editor.value;

    // 在刚插入的结束符号前再输入结束符号时会跳过它，
    // 而不会产生 `())`。
    if (PAIR_CLOSERS[key] && start === end && value.charAt(end) === key) {
      event.preventDefault();
      dom.editor.setSelectionRange(end + 1, end + 1);
      updateStatusBar();
      return true;
    }

    var closer = PAIR_OPENERS[key];
    if (!closer) { return false; }

    if (start !== end) {
      event.preventDefault();
      wrapSelection(key, closer, '');
      return true;
    }

    if (PAIR_WORD_SENSITIVE[key] &&
        (isWordCharAt(value, start - 1) || isWordCharAt(value, end))) {
      return false;
    }

    event.preventDefault();
    dom.editor.setRangeText(key + closer, start, end, 'end');
    commitEdit(start + 1, start + 1, true);
    return true;
  }

  // ------------------------------------------------------------ 表格工具

  function splitTableRow(line) {
    var text = String(line).trim();
    if (text.charAt(0) === '|') { text = text.slice(1); }
    if (text.charAt(text.length - 1) === '|') { text = text.slice(0, -1); }
    return text.split('|').map(function (cell) { return cell.trim(); });
  }

  function joinTableRow(cells) {
    return '| ' + cells.join(' | ') + ' |';
  }

  function isSeparatorRow(line) {
    return /^[\s|:-]*-[\s|:-]*$/.test(String(line)) && String(line).indexOf('-') >= 0;
  }

  /** 定位光标所在的表格，没有则返回 null。 */
  function tableAt() {
    var value = dom.editor.value;
    var caret = dom.editor.selectionStart;
    var lines = value.split('\n');

    var starts = [];
    var offset = 0;
    for (var i = 0; i < lines.length; i++) {
      starts.push(offset);
      offset += lines[i].length + 1;
    }

    var index = 0;
    for (var j = 0; j < lines.length; j++) { if (starts[j] <= caret) { index = j; } }
    if (lines[index].indexOf('|') < 0) { return null; }

    var top = index;
    while (top > 0 && lines[top - 1].indexOf('|') >= 0 && lines[top - 1].trim()) { top--; }
    var bottom = index;
    while (bottom + 1 < lines.length && lines[bottom + 1].indexOf('|') >= 0 && lines[bottom + 1].trim()) { bottom++; }
    if (bottom - top < 1 || !isSeparatorRow(lines[top + 1])) { return null; }

    var column = 0;
    for (var k = starts[index]; k < caret; k++) {
      if (value.charAt(k) === '|') { column++; }
    }

    return {
      lines: lines, starts: starts, top: top, bottom: bottom,
      index: index, column: column,
    };
  }

  function writeTable(table, rows) {
    var start = table.starts[table.top];
    var end = table.starts[table.bottom] + table.lines[table.bottom].length;
    var text = rows.join('\n');
    dom.editor.setRangeText(text, start, end, 'preserve');
    commitEdit(start, start + text.length, true);
    renderPreview();
  }

  function tableOp(kind) {
    var table = tableAt();
    if (!table) {
      toast('把光标放进表格里再用这些操作', true);
      return false;
    }

    var rows = table.lines.slice(table.top, table.bottom + 1);
    var header = splitTableRow(rows[0]);
    var bodyStart = 2;                      // rows[0] 表头，rows[1] 分隔行
    var rowIndex = table.index - table.top; // 表格内从 0 开始的行号
    var columnCount = header.length;
    var column = clamp(table.column, 0, Math.max(0, columnCount - 1));

    if (kind === 'rowAbove' || kind === 'rowBelow') {
      var blank = [];
      for (var c = 0; c < columnCount; c++) { blank.push('   '); }
      var at = kind === 'rowBelow' ? rowIndex + 1 : rowIndex;
      at = Math.max(at, bodyStart);          // 绝不插到表头分隔行之上
      at = Math.min(at, rows.length);
      rows.splice(at, 0, joinTableRow(blank));
      writeTable(table, rows);
      toast('已插入行');
      return true;
    }

    if (kind === 'rowDelete') {
      if (rowIndex < bodyStart) {
        toast('表头行不能删除', true);
        return false;
      }
      rows.splice(rowIndex, 1);
      writeTable(table, rows);
      toast('已删除行');
      return true;
    }

    if (kind === 'columnLeft' || kind === 'columnRight') {
      var at2 = kind === 'columnRight' ? column + 1 : column;
      for (var r = 0; r < rows.length; r++) {
        var cells = splitTableRow(rows[r]);
        while (cells.length <= at2) { cells.push(''); }
        cells.splice(at2, 0, rows[r] === rows[1] ? '---' : '   ');
        rows[r] = joinTableRow(cells);
      }
      writeTable(table, rows);
      toast('已插入列');
      return true;
    }

    if (kind === 'columnDelete') {
      if (columnCount <= 1) {
        toast('至少保留一列', true);
        return false;
      }
      for (var d = 0; d < rows.length; d++) {
        var list = splitTableRow(rows[d]);
        list.splice(column, 1);
        rows[d] = joinTableRow(list);
      }
      writeTable(table, rows);
      toast('已删除列');
      return true;
    }

    if (kind === 'alignLeft' || kind === 'alignCenter' || kind === 'alignRight') {
      var marker = kind === 'alignCenter' ? ':---:' : (kind === 'alignRight' ? '---:' : ':---');
      var separator = splitTableRow(rows[1]);
      while (separator.length < columnCount) { separator.push('---'); }
      separator[column] = marker;
      rows[1] = joinTableRow(separator);
      writeTable(table, rows);
      toast('已设置列对齐');
      return true;
    }

    return false;
  }

  // ------------------------------------------------------------ 图片工具

  /** 为光标所在的图片添加/替换 `{...}` 属性块。 */
  function setImageAlignment(align) {
    var value = dom.editor.value;
    var caret = dom.editor.selectionStart;
    var start = value.lastIndexOf('\n', caret - 1) + 1;
    var end = value.indexOf('\n', caret);
    if (end < 0) { end = value.length; }

    var line = value.slice(start, end);
    var expression = /!\[[^\]]*\]\([^)]*\)(\{[^}\n]*\})?/;
    var match = expression.exec(line);
    if (!match) {
      toast('光标所在行没有图片', true);
      return false;
    }

    var image = match[0].replace(/\{[^}\n]*\}$/, '');
    var replacement = align ? image + '{' + align + '}' : image;
    var at = start + match.index;
    dom.editor.setRangeText(replacement, at, at + match[0].length, 'preserve');
    commitEdit(at, at + replacement.length, true);
    renderPreview();
    toast(align ? '图片已' + ({ left: '左对齐', center: '居中', right: '右对齐' })[align] : '图片已恢复默认对齐');
    return true;
  }

  function insertImageFromUrl() {
    var tab = activeTab();
    if (!tab) { return; }
    if (!tab.path) {
      toast('请先保存文档，图片会下载到文档同级的 assets 目录', true);
      return;
    }

    showDialog({
      title: '插入网络图片',
      message: '图片会下载到文档同级的 assets 目录，离线也能看。',
      input: true,
      value: 'https://',
      buttons: [
        { label: '取消', value: 'cancel' },
        { label: '下载并插入', value: 'ok', primary: true },
      ],
    }).then(function (result) {
      if (result.value !== 'ok') { return; }
      var url = (result.text || '').trim();
      if (!/^https?:\/\//i.test(url)) {
        toast('请输入 http/https 图片地址', true);
        return;
      }

      var name = url.split(/[?#]/)[0].split('/').pop() || 'image.png';
      name = name.replace(/[^\w.\-\u3400-\u9fff]/g, '_') || 'image.png';
      if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) { name += '.png'; }

      hostCall('downloadUrl', { url: url, dir: tab.path.replace(/[^\\/]+$/, ''), name: name })
        .then(function (data) {
          if (!data || !data.relative) { toast('下载失败', true); return; }
          var position = dom.editor.selectionStart;
          var snippet = '![图片](' + data.relative + ')';
          dom.editor.setRangeText(snippet, position, position, 'end');
          commitEdit(position + snippet.length, position + snippet.length, true);
          renderPreview();
          toast('图片已保存到 ' + data.relative);
        })
        .catch(function (error) { toast(error.message, true); });
    });
  }

  function printDocument() {
    // 打印渲染的是页面而非模型，因此每个块都必须先进入 DOM。之后刻意不恢复窗口：
    // 打印对话框是模态且异步的，下一次滚动或按键自然会把这个窗格放回原处。
    drawAllPreviewBlocks();
    hostCall('print').then(function () {
      toast('已打开打印对话框');
    }).catch(function (error) { toast(error.message, true); });
  }

  // --------------------------------------------------------- 富文本复制

  /**
   * 按 HTML 复制渲染后的预览内容，这样粘贴到 Word 或邮件里时标题、加粗和列表都能
   * 保留。浏览器在复制选区时会把 `text/html` 放进剪贴板，而那正是这些程序所读取的。
   */
  /** 最终进入剪贴板的标记，已按文字处理软件的需要设置样式。 */
  function buildRichText() {
    var tab = activeTab();
    if (!tab) { return null; }
    if (previewStale) { renderPreview(true); }
    var holder = document.createElement('div');
    holder.setAttribute('contenteditable', 'true');
    holder.style.position = 'fixed';
    holder.style.left = '-10000px';
    holder.style.top = '0';
    holder.innerHTML = '<article class="md">' + (tab.renderedHtml || '') + '</article>';
    document.body.appendChild(holder);

    // 浏览器对基于类的样式复制得很不一致，因此先把对文字处理软件有意义的少数属性
    // 内联进去。
    var article = holder.querySelector('article');
    var computed = getComputedStyle(dom.preview);
    article.style.fontFamily = computed.fontFamily;
    article.style.fontSize = computed.fontSize;
    article.style.lineHeight = computed.lineHeight;
    article.style.color = computed.color;
    Array.prototype.forEach.call(holder.querySelectorAll('h1, h2, h3, h4, h5, h6'), function (heading) {
      var style = getComputedStyle(heading);
      heading.style.fontSize = style.fontSize;
      heading.style.fontWeight = style.fontWeight;
      heading.style.margin = style.margin;
    });

    return { holder: holder, html: holder.innerHTML, text: holder.innerText };
  }

  async function copyRichText() {
    var payload = buildRichText();
    if (!payload) { return false; }

    var holder = payload.holder;
    var copied = false;
    var reason = '';

    // 优先走原生实现：浏览器只在窗口获得焦点时才写入剪贴板，
    // 而宿主还能在同一次操作里顺便写入 RTF。
    try {
      var data = await hostCall('copyRich', {
        html: payload.html,
        text: payload.text,
        rtf: buildRtf(),
      });
      copied = !!(data && data.copied);
    } catch (error) { reason = error.message; }

    if (!copied) {
      var range = document.createRange();
      range.selectNodeContents(holder);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
      selection.removeAllRanges();
    }

    if (!copied && navigator.clipboard && navigator.clipboard.write && window.ClipboardItem) {
      try {
        await Promise.race([
          navigator.clipboard.write([new ClipboardItem({
            'text/html': new Blob([payload.html], { type: 'text/html' }),
            'text/plain': new Blob([payload.text], { type: 'text/plain' }),
          })]),
          sleep(1200).then(function () { throw new Error('剪贴板没有响应'); }),
        ]);
        copied = true;
      } catch (error) { reason = error.message; }
    }

    state.copyError = copied ? '' : (reason || '剪贴板被拒绝');
    holder.remove();
    toast(copied ? '已复制为富文本' : '复制失败：' + state.copyError, !copied);
    return copied;
  }

  function onKeyDown(event) {
    var key = event.key;
    var ctrl = event.ctrlKey || event.metaKey;
    var alt = event.altKey;
    var shift = event.shiftKey;

    // 屏幕上并非只有笔记一个文本输入区。当光标位于查找框、对话框输入框或文件搜索框时，
    // 按键归这些输入框所有：Ctrl+B 不能给它们背后的选区加粗，
    // Ctrl+Z 应当撤销输入框里的内容而不是文档。只有真正作用于整个窗口的快捷键才保持
    // 有效。
    var target = event.target;
    var inField = !!target && target !== dom.editor &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true);
    if (inField && key !== 'Escape') {
      var windowWide = ctrl && !alt && !shift &&
        (key === 's' || key === 'S' || key === 'f' || key === 'F');
      if (!windowWide) { return; }
    }

    // 键入字符（或完成一次输入法上屏）可能让编辑器滚动以保持光标可见；
    // 那次滚动并不是读者在移动窗格。
    // 判断的是*纯*字符键，或一次输入法上屏。修饰键的判断并非摆设：按下 Ctrl+A 时
    // `key` 同样是 `'a'`，没有这项判断，每个 Ctrl+字母快捷键都会自称在打字——
    // 而它开启的时间窗口（见下）会让同步逻辑把该窗格接下来半秒的滚动都当成
    // “为保持光标可见而滚动”。Ctrl+A、Ctrl+S、Ctrl+B、Ctrl+Z：编辑器动了，
    // 阅读窗格却停在原地，两者差了一整屏。
    if (target === dom.editor && (composing || (key.length === 1 && !ctrl && !alt))) {
      editorTypingUntil = Date.now() + TYPING_MS;
    }

    if (ctrl && !alt && !shift) {
      var plain = {
        n: newTab,
        o: openDialog,
        s: function () { saveTab(false); },
        w: function () { closeTab(state.activeId); },
        // Ctrl+F 打开查找栏，再按一次同一个键收起它。
        f: function () {
          if (dom.findbar.classList.contains('is-on')) { closeFind(); return; }
          openFind();
        },
        k: insertLink,
        b: ACTIONS.bold,
        i: ACTIONS.italic,
        d: ACTIONS.strike,
        e: ACTIONS.mark,
        z: undo,
        y: redo,
        p: printDocument,
        '1': function () { setViewMode('edit'); },
        '2': function () { setViewMode('split'); },
        '3': function () { setViewMode('read'); },
        '0': function () {
          state.config.fontSize = 16;
          applyConfig();
          saveConfig();
        },
        '`': ACTIONS.code,
        '\\': toggleSidebar,
      };

      if (key === 'Tab') {
        event.preventDefault();
        var index = state.tabs.indexOf(activeTab());
        var next = state.tabs[(index + 1) % state.tabs.length];
        if (next) { activateTab(next.id); }
        return;
      }
      if (key === '+' || key === '=') { event.preventDefault(); bumpZoom(1); return; }
      if (key === '-') { event.preventDefault(); bumpZoom(-1); return; }
      if (key === 'a' && event.target === dom.editor) {
        event.preventDefault();
        dom.editor.select();
        return;
      }

      var handler = plain[key.toLowerCase()];
      if (handler) { event.preventDefault(); handler(); return; }
    }

    // 配对在浏览器插入字符之前执行，且仅在编辑器内的普通输入时生效。
    if (!ctrl && !alt && event.target === dom.editor && !composing &&
        key.length === 1 && autoPair(event)) {
      return;
    }

    if (ctrl && shift && !alt) {
      var shifted = {
        s: function () { saveTab(true); },
        c: ACTIONS.codeblock,
        i: insertImage,
        m: insertMath,
        e: exportHtml,
        p: exportPdf,
        f: function () { insertBlock('[^1]: 脚注内容'); },
      };
      var shiftedHandler = shifted[key.toLowerCase()];
      if (shiftedHandler) { event.preventDefault(); shiftedHandler(); return; }
    }

    if (ctrl && alt && !shift) {
      var altMap = { '1': 'h1', '2': 'h2', '3': 'h3', u: 'ul', o: 'ol', x: 'task', t: 'table', q: 'quote' };
      var action = altMap[key.toLowerCase()];
      if (action) { event.preventDefault(); ACTIONS[action](); return; }
    }

    if (key === 'F1') { event.preventDefault(); dom.helpModal.classList.add('is-on'); return; }
    if (key === 'F8') { event.preventDefault(); toggleSetting('focusMode'); return; }
    if (key === 'F9') { event.preventDefault(); toggleSetting('typewriter'); return; }

    if (key === 'Escape') {
      if (dom.dialog.classList.contains('is-on')) { closeDialog('cancel'); return; }
      if (dom.findbar.classList.contains('is-on')) { closeFind(); return; }
      if (dom.helpModal.classList.contains('is-on')) { dom.helpModal.classList.remove('is-on'); return; }
      if (dom.themePopover.classList.contains('is-on') ||
          dom.exportPopover.classList.contains('is-on') ||
          dom.ctxmenu.classList.contains('is-on')) {
        closePopovers();
        return;
      }
      if (state.config.focusMode) { exitFocusMode(false); return; }
      closePopovers();
      return;
    }

    if (key === 'Tab' && event.target === dom.editor) {
      event.preventDefault();
      // 在围栏内部，缩进作用于光标处并按代码尺寸计算；
      // 在外部则仍是整体缩进 Markdown 行。
      if (insideCodeFence() && !composing) { indentCode(shift); return; }
      indentSelection(shift);
      return;
    }

    // Enter 也会确认输入法候选词；composing 标志把两者区分开，
    // 否则选一个中文词会变成插入一个换行。
    if (key === 'Enter' && event.target === dom.editor && !shift && !ctrl && !alt &&
        !composing && !event.isComposing) {
      // 处理函数会自行插入换行，因此必须取消浏览器自己的换行——
      // 否则围栏内每次按 Enter 都会产生两行，并把光标留在带缩进的空行行首。
      if (continueCodeIndent()) { event.preventDefault(); return; }
      continueList(event);
      return;
    }
  }

  // ----------------------------------------------------------------- 事件绑定

  function wire() {
    dom.editor.addEventListener('input', function () {
      if (suppressInput) { return; }
      var tab = activeTab();
      if (!tab) { return; }
      // 接下来会为保持光标可见而滚动；那次滚动不是读者所为。
      editorTypingUntil = Date.now() + TYPING_MS;
      tab.text = editorText();
      snapshot(tab, false);
      markDirty(tab);
      // 在输入法组字过程中重新装饰会破坏组字。编辑区已经在显示组字文本，
      // 因此配色可以再等等。
      if (!composing) { scheduleHighlight(); }
      scheduleTypewriter();
      // 理由相同，还多一条：组字内容此时还算不上文档。每一次拼音输入都会用半截字母
      // 重新渲染阅读窗格，让读者眼前的段落不断重排。
      // 预览只在组字结束时绘制一次。
      if (!composing) { schedulePreview(); }
      updateStatusBar();
      scheduleAutoSave();
    });

    // 用键盘或鼠标选择内容时，要让光标读数保持准确。
    document.addEventListener('selectionchange', function () {
      var offsets = readCaretOffsets();
      if (!offsets) { return; }
      // 光标读数以及查找栏的“把你放回原处”都要读它，而用方向键移动的光标从不经过
      // placeCaret()，因此最近一次已知位置也必须在这里记录。
      lastCaret = { start: offsets.start, end: offsets.end };
      updateCursorStatus();
    });

    dom.editorScroll.addEventListener('scroll', function () {
      var scrolling = readerIsScrolling(dom.editorScroll);
      if (scrolling) { scheduleSync('editor'); }
      var tab = activeTab();
      if (tab && !activating) { tab.scrollTop = dom.editorScroll.scrollTop; }
      // 标记不仅为读者刷新，也为程序化放置刷新：当被滚动的是阅读窗格时，
      // 本窗格会晚一帧到位，而那一帧正是标记能读到正确答案的时刻。
      // 由应用发起的*跳转*式移动则改为保持 `outlineQuiet`。
      if (!activating) { updateOutlineFromViewport(); }
      // 重绘窗口是一帧量级的工作，因此它搭乘滚动帧执行，而不是每个滚动事件都跑一次。
      if (!windowFrame) {
        windowFrame = requestAnimationFrame(function () {
          windowFrame = 0;
          refreshWindowForScroll();
        });
      }
    });
    dom.previewScroll.addEventListener('scroll', function () {
      // 本代码造成的滚动后面已经跟着一次跑完的排版，
      // 因此不应再排入一次。
      var ours = isPlacementEcho(dom.previewScroll);
      if (!ours && readerIsScrolling(dom.previewScroll)) { scheduleSync('preview'); }
      updateOutlineFromViewport();
      if (ours) { return; }
      // 窗口每帧重算一次，而不是每个事件一次：扫描开销与块数量成线性关系，
      // 而一次滚轮手势触发的事件远多于屏幕刷新次数。
      if (previewLayoutFrame) { return; }
      previewLayoutFrame = requestAnimationFrame(function () {
        previewLayoutFrame = 0;
        layoutPreview();
        // 排版刚刚测量了读者附近的块并还原了锚定行；如果正在阅读的是预览窗格，
        // 编辑器就要按这个稳定后的位置重新放置，而不是按排版替换掉的那个位置。
        if (syncLeader === 'preview') { scheduleSync('preview'); }
      });
    });
    document.addEventListener('keydown', onKeyDown);
    dom.editor.addEventListener('contextmenu', editorContextMenu);
    dom.preview.addEventListener('contextmenu', previewContextMenu);

    ['click', 'keyup', 'select'].forEach(function (type) {
      dom.editor.addEventListener(type, updateStatusBar);
    });
    dom.editor.addEventListener('blur', function () { persistTabView(activeTab()); });

    dom.editor.addEventListener('compositionstart', function () {
      composing = true;
    });
    dom.editor.addEventListener('compositionend', function () {
      composing = false;
      editorTypingUntil = Date.now() + TYPING_MS;
      renderHighlightNow();
      schedulePreview();
      updateStatusBar();
    });

    dom.editor.addEventListener('paste', function (event) {
      var items = event.clipboardData && event.clipboardData.items;
      if (items) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].type.indexOf('image/') === 0) {
            event.preventDefault();
            var file = items[i].getAsFile();
            if (file) { insertImageFromFile(file, dom.editor.selectionStart); }
            return;
          }
        }
      }

      // 粘贴富文本会把外来的标记注入到用来重建装饰的编辑区中，
      // 因此只接受纯文本。
      var plain = event.clipboardData && event.clipboardData.getData('text/plain');
      if (plain == null) { return; }
      event.preventDefault();
      insertPlainText(plain);
    });

    dom.editor.addEventListener('drop', function (event) {
      var files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) {
        // 拖入的文本同样不能以 HTML 形式进入。
        var dropped = event.dataTransfer && event.dataTransfer.getData('text/plain');
        if (dropped) {
          event.preventDefault();
          insertPlainText(dropped);
        }
        return;
      }
      event.preventDefault();

      var image = null;
      var markdown = null;
      for (var i = 0; i < files.length; i++) {
        if (files[i].type.indexOf('image/') === 0 && !image) { image = files[i]; }
        if (/\.(md|markdown|mdown|mkd|txt)$/i.test(files[i].name) && !markdown) { markdown = files[i]; }
      }

      if (image) { insertImageFromFile(image); return; }
      if (markdown) {
        markdown.text().then(function (text) {
          var tab = makeTab({ name: markdown.name, text: text });
          tab.dirty = true;
          activateTab(tab.id);
          toast('已载入 ' + markdown.name + '，保存时选择位置即可');
        });
      }
    });

    document.addEventListener('dragover', function (event) { event.preventDefault(); });
    document.addEventListener('drop', function (event) {
      if (event.target === dom.editor) { return; }
      event.preventDefault();
    });

    dom.preview.addEventListener('click', onPreviewClick);

    dom.tabs.addEventListener('click', function (event) {
      var close = event.target.closest('[data-close]');
      if (close) {
        event.stopPropagation();
        closeTab(parseInt(close.dataset.close, 10));
        return;
      }
      var tab = event.target.closest('.tab');
      if (tab) { activateTab(parseInt(tab.dataset.id, 10)); }
    });

    // 新建标签按钮位于滚动条带之外，因此它的点击不会传到这里，
    // 尽管它看起来像是这一行的一部分。
    dom.tabNew.addEventListener('click', function () { newTab(); });

    dom.tabs.addEventListener('auxclick', function (event) {
      var tab = event.target.closest('.tab');
      if (tab && event.button === 1) { closeTab(parseInt(tab.dataset.id, 10)); }
    });

    dom.toolbar.addEventListener('click', function (event) {
      var button = event.target.closest('[data-act]');
      if (!button) { return; }
      var action = ACTIONS[button.dataset.act];
      if (!action) { return; }

      // 先聚焦再执行操作，因为操作要从编辑器读取光标位置。若反过来，在操作刚打开的
      // 对话框之后才聚焦，会把光标直接从对话框里拽出来——showDialog 会同步地聚焦它
      // 的输入框——结果从工具栏点击“插入链接”后根本没法输入。
      dom.editor.focus();
      action();
    });

    dom.outline.addEventListener('click', function (event) {
      var button = event.target.closest('.outline-item');
      if (button) { scrollToHeading(parseInt(button.dataset.index, 10)); }
    });

    Array.prototype.forEach.call(dom.viewSwitch.children, function (button) {
      button.addEventListener('click', function () { setViewMode(button.dataset.mode); });
    });

    dom.activity.addEventListener('click', function (event) {
      var button = event.target.closest('.abtn[data-panel]');
      if (!button) { return; }
      if (state.config.sidebar && button.dataset.panel === state.config.sidebarTab) {
        toggleSidebar();
        return;
      }
      selectSidebarPanel(button.dataset.panel, true);
    });

    dom.btnSidebar.addEventListener('click', toggleSidebar);
    // 放大镜按钮用于切换：再点一次收起查找栏。
    dom.btnFind.addEventListener('click', function () {
      if (dom.findbar.classList.contains('is-on')) { closeFind(); return; }
      openFind();
    });

    // 窗口置顶。窗口标志由宿主掌握，并会回报最终结果，
    // 因此按钮无需自行猜测。
    dom.btnTopmost.addEventListener('click', function () {
      setTopmost(!state.config.topmost);
    });

    /**
     * 打开或关闭窗口置顶。
     *
     * 窗口标志由宿主掌握并回报最终结果，因此这里发送的是目标状态而不是切换指令：
     * 否则一条需要重发的命令（消息桥接在控件繁忙时可能拒绝它）会把窗口来回切换两次。
     */
    function setTopmost(on) {
      hostCall('window', { action: 'topmost', on: on === true }).then(function (data) {
        state.config.topmost = !!(data && data.topmost);
        dom.btnTopmost.classList.toggle('is-on', state.config.topmost);
        saveConfig();
        toast(state.config.topmost ? '窗口已置顶' : '已取消置顶');
      }).catch(function (error) { toast(error.message, true); });
    }

    // 把所有已打开的笔记列在一张表里，供标签条放不下时使用。
    dom.tabAll.addEventListener('click', function () {
      if (!state.tabs.length) { return; }
      var rect = dom.tabAll.getBoundingClientRect();
      showContextMenu(rect.right - 220, rect.bottom + 2, state.tabs.map(function (tab) {
        return {
          key: 'tab-' + tab.id,
          label: (tab.id === state.activeId ? '● ' : '') + tabTitle(tab),
          run: function () { activateTab(tab.id); },
        };
      }));
    });
    dom.btnHelp.addEventListener('click', function () { dom.helpModal.classList.add('is-on'); });
    dom.helpClose.addEventListener('click', function () { dom.helpModal.classList.remove('is-on'); });
    dom.helpModal.addEventListener('click', function (event) {
      if (event.target === dom.helpModal) { dom.helpModal.classList.remove('is-on'); }
    });

    dom.dialog.addEventListener('click', function (event) {
      if (event.target === dom.dialog) { closeDialog('cancel'); }
    });
    $('dialogInput').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        closeDialog('ok');
      }
    });

    dom.btnPickFolder.addEventListener('click', pickFolder);
    dom.btnRefreshTree.addEventListener('click', renderFilePanel);
    bindTreeSearch();
    dom.fileTree.addEventListener('contextmenu', treeContextMenu);

    dom.btnTableTools.addEventListener('click', function () {
      buildTablePopover();
      togglePopover(dom.tablePopover, dom.btnTableTools);
    });
    dom.tablePopover.addEventListener('click', function (event) {
      var item = event.target.closest('[data-table]');
      if (!item) { return; }
      closePopovers();
      tableOp(item.dataset.table);
    });

    dom.btnImage.addEventListener('click', function () {
      buildImagePopover();
      togglePopover(dom.imagePopover, dom.btnImage);
    });
    dom.imagePopover.addEventListener('click', function (event) {
      var item = event.target.closest('[data-image]');
      if (!item) { return; }
      closePopovers();
      var kind = item.dataset.image;
      if (kind === 'file') { insertImage(); }
      else if (kind === 'url') { insertImageFromUrl(); }
      else { setImageAlignment(kind); }
    });

    dom.btnTheme.addEventListener('click', function () {
      buildThemePopover();
      togglePopover(dom.themePopover, dom.btnTheme);
    });

    dom.btnExport.addEventListener('click', function () {
      buildExportPopover();
      togglePopover(dom.exportPopover, dom.btnExport);
    });

    dom.themePopover.addEventListener('click', function (event) {
      var swatch = event.target.closest('[data-theme]');
      if (!swatch) { return; }
      setTheme(swatch.dataset.theme);
      buildThemePopover();
    });

    dom.exportPopover.addEventListener('click', function (event) {
      var item = event.target.closest('[data-export]');
      if (!item) { return; }
      closePopovers();
      var kind = item.dataset.export;
      if (kind === 'html') { exportHtml(); }
      else if (kind === 'pdf') { exportPdf(); }
      else if (kind === 'text') { exportText(); }
      else if (kind === 'rtf') { exportRtf(); }
      else if (kind === 'image') { exportLongImage(); }
      else if (kind === 'print') { printDocument(); }
      else if (kind === 'rich') { copyRichText(); }
      else if (kind === 'copy') { copyHtmlSource(); }
      else if (kind === 'reveal') {
        var tab = activeTab();
        hostCall('reveal', { path: tab && tab.path ? tab.path : (state.treeRoot || '') });
      }
    });

    document.addEventListener('mousedown', function (event) {
      if (event.target.closest('.popover') || event.target.closest('.ctxmenu')) { return; }
      if (event.target.closest('#btnTheme') || event.target.closest('#btnExport') ||
          event.target.closest('#btnTableTools') || event.target.closest('#btnImage')) { return; }
      closePopovers();
    });

    dom.titlebar.addEventListener('mousedown', function (event) {
      if (event.button !== 0 || event.target.closest('button')) { return; }
      if (event.target.closest('.tb-drag') || event.target.closest('.brand')) {
        // 阻止网页视图捕获这次按下：宿主紧接着启动的移动循环需要这个按键仍属于
        // 窗口框架。
        event.preventDefault();
        hostCall('drag');
      }
    });

    dom.titlebar.addEventListener('dblclick', function (event) {
      if (event.target.closest('button')) { return; }
      toggleMaximize();
    });

    dom.winMin.addEventListener('click', function () { hostCall('window', { action: 'minimize' }); });
    dom.winMax.addEventListener('click', toggleMaximize);
    dom.winMax.addEventListener('mouseenter', function () { hostCall('maximizeHover', { hover: true }); });
    dom.winMax.addEventListener('mouseleave', function () { hostCall('maximizeHover', { hover: false }); });
    dom.winClose.addEventListener('click', requestClose);

    dom.statusPath.addEventListener('click', function () {
      var tab = activeTab();
      if (!tab || !tab.path) { return; }
      navigator.clipboard.writeText(tab.path).then(function () { toast('路径已复制'); });
    });

    dom.statusZoom.addEventListener('click', function () {
      state.config.fontSize = 16;
      applyConfig();
      saveConfig();
    });

    dom.findInput.addEventListener('input', function () { runFind(true); });
    dom.findInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); stepMatch(event.shiftKey ? -1 : 1); }
    });
    dom.replaceInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); replaceCurrent(); }
    });
    dom.findNext.addEventListener('click', function () { stepMatch(1); });
    dom.findPrev.addEventListener('click', function () { stepMatch(-1); });
    dom.findReplace.addEventListener('click', replaceCurrent);
    dom.findReplaceAll.addEventListener('click', replaceAll);

    var resizeFrame = 0;
    window.addEventListener('resize', function () {
      if (resizeFrame) { return; }
      resizeFrame = requestAnimationFrame(function () {
        resizeFrame = 0;
        relayoutEditor();
        syncPreviewFromEditor();
        // 停在右边缘或下边缘附近的查找栏，必须在窗口（及其窗格）缩小时回到可视区内。
        if (dom.findbar.style.left) {
          placeFindbar(parseFloat(dom.findbar.style.left), parseFloat(dom.findbar.style.top));
        }
      });
    });

    // 承载文字的列会因为多种原因改变宽度——侧边栏的宽度过渡、拖动分隔条、窗口缩放，
    // 以及滚动条的出现或消失。直接观察内容列本身即可覆盖全部情形，
    // 而不必去猜何时需要重新测量；只观察窗格会漏掉滚动条，
    // 它会让折行宽度变化 11px，使文字比测得的高度多出一行。
    if (window.ResizeObserver) {
      new ResizeObserver(function () { relayoutEditor(); }).observe(dom.editorPage);
    }

    wireSettings();
    wireSplitter();
    wireFindDrag();
  }

  function onPreviewClick(event) {
    var checkbox = event.target.closest && event.target.closest('.md-checkbox');
    if (checkbox) {
      var item = checkbox.closest('.md-task');
      if (item) {
        var lineIndex = parseInt(item.dataset.line, 10);
        var lines = dom.editor.value.split('\n');
        if (lines[lineIndex] != null) {
          lines[lineIndex] = lines[lineIndex].replace(
            /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/,
            function (all, head, state, tail) {
              return head + (state.toLowerCase() === 'x' ? ' ' : 'x') + tail;
            });
            var caret = dom.editor.selectionStart;
            dom.editor.value = lines.join('\n');
            dom.editor.setSelectionRange(caret, caret);
            commitEdit(null, null, true);
          renderPreview();
        }
        return;
      }
    }

    var copy = event.target.closest && event.target.closest('.md-code-copy');
    if (copy) {
      var code = copy.closest('.md-code-block').querySelector('code');
      navigator.clipboard.writeText(code.innerText).then(function () { toast('代码已复制'); });
      return;
    }

    var link = event.target.closest && event.target.closest('a');
    if (link) {
      var href = link.getAttribute('href') || '';
      if (href.charAt(0) === '#') {
        event.preventDefault();
        var target = dom.preview.querySelector('#' + cssEscape(decodeURIComponent(href.slice(1))));
        if (target) { target.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
        return;
      }
      if (/^https?:/i.test(href)) {
        event.preventDefault();
        hostCall('openExternal', { url: href });
      }
    }
  }

  function toggleMaximize() {
    hostCall('window', { action: 'maximize' }).then(function (data) {
      var maximized = !!(data && data.maximized);
      dom.winMaxIcon.querySelector('use').setAttribute('href', maximized ? '#i-restore' : '#i-max');
      dom.winMax.title = maximized ? '还原' : '最大化';
    }).catch(function () {});
  }

  /**
   * 让查找栏可以被拖开，以免挡住命中项。
   *
   * 输入框和按钮保留各自的点击行为，查找栏的其余部分可以拖动。位置会被限制在窗格
   * 范围内，因为一旦拖出边缘，查询词和所有按钮都会跟着消失，再没有找回它的办法。
   */
  function wireFindDrag() {
    var dragging = null;

    dom.findbar.addEventListener('mousedown', function (event) {
      if (event.button !== 0) { return; }
      if (event.target.closest('input, button')) { return; }
      var box = dom.findbar.getBoundingClientRect();
      dragging = { x: event.clientX - box.left, y: event.clientY - box.top };
      dom.findbar.classList.add('is-dragging');
      event.preventDefault();
    });

    document.addEventListener('mousemove', function (event) {
      if (!dragging) { return; }
      var host = dom.findbar.offsetParent;
      if (!host) { return; }
      var hostBox = host.getBoundingClientRect();
      placeFindbar(event.clientX - hostBox.left - dragging.x,
                   event.clientY - hostBox.top - dragging.y);
    });

    document.addEventListener('mouseup', function () {
      if (!dragging) { return; }
      dragging = null;
      dom.findbar.classList.remove('is-dragging');
      if (dom.findbar.style.left) {
        state.config.findLeft = parseFloat(dom.findbar.style.left);
        state.config.findTop = parseFloat(dom.findbar.style.top);
        saveConfig();
      }
    });
  }

  /** 把查找栏放回上次拖动后停留的位置。 */
  function restoreFindPlacement() {
    if (state.config.findLeft == null || state.config.findTop == null) { return; }
    placeFindbar(state.config.findLeft, state.config.findTop);
  }

  /** 把查找栏放到其所在窗格中的 (left, top) 处，并确保完全在窗格内。 */
  function placeFindbar(left, top) {
    var host = dom.findbar.offsetParent;
    if (!host) { return; }
    var maxLeft = Math.max(0, host.clientWidth - dom.findbar.offsetWidth);
    var maxTop = Math.max(0, host.clientHeight - dom.findbar.offsetHeight);
    dom.findbar.style.left = Math.round(clamp(left, 0, maxLeft)) + 'px';
    dom.findbar.style.top = Math.round(clamp(top, 0, maxTop)) + 'px';
    dom.findbar.style.right = 'auto';
  }

  /**
   * 绘制滑块已填充的部分。
   *
   * 滑轨现在由 CSS 渐变绘制，因此必须把比例交给它：原生控件过去会自行填充进度，
   * 并在交界处留下一道接缝，用户要求去掉的正是它。
   */
  function syncRangeFills() {
    [dom.setFontSize, dom.setLineHeight, dom.setContentWidth].forEach(function (range) {
      if (!range) { return; }
      var min = parseFloat(range.min) || 0;
      var max = parseFloat(range.max) || 100;
      var value = parseFloat(range.value) || 0;
      var percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
      range.style.setProperty('--range-fill', percent + '%');
    });
  }

  function wireSettings() {
    dom.setFontSize.addEventListener('input', function () {
      state.config.fontSize = parseInt(dom.setFontSize.value, 10);
      dom.valFontSize.textContent = state.config.fontSize + ' px';
      applyConfig();
      saveConfig();
    });
    dom.setLineHeight.addEventListener('input', function () {
      state.config.lineHeight = parseInt(dom.setLineHeight.value, 10) / 100;
      dom.valLineHeight.textContent = state.config.lineHeight.toFixed(2);
      applyConfig();
      saveConfig();
    });
    dom.setContentWidth.addEventListener('input', function () {
      state.config.contentWidth = parseInt(dom.setContentWidth.value, 10);
      dom.valContentWidth.textContent = state.config.contentWidth + ' px';
      applyConfig();
      saveConfig();
    });
    dom.setFontFamily.addEventListener('change', function () {
      state.config.fontFamily = dom.setFontFamily.value;
      applyConfig();
      saveConfig();
    });
    dom.setGutter.addEventListener('click', function () {
      state.config.showLineNumbers = !state.config.showLineNumbers;
      applyConfig();
      saveConfig();
    });
    dom.setTypewriter.addEventListener('click', function () { toggleSetting('typewriter'); });
    dom.setFocus.addEventListener('click', function () { toggleSetting('focusMode'); });
    dom.setAutoSave.addEventListener('click', function () {
      state.config.autoSave = !state.config.autoSave;
      applyConfig();
      saveConfig();
      toast(state.config.autoSave ? '已开启自动保存' : '已关闭自动保存');
    });
    dom.themeGrid.addEventListener('click', function (event) {
      var swatch = event.target.closest('[data-theme]');
      if (!swatch) { return; }
      setTheme(swatch.dataset.theme);
    });
  }

  function buildShortcutList() {
    dom.shortcutGrid.innerHTML = SHORTCUTS.map(function (item) {
      return '<div class="shortcut-row"><span>' + esc(item[0]) + '</span><span class="keys">' +
        item[1].split(' ').map(function (key) {
          return '<kbd>' + esc(key) + '</kbd>';
        }).join('') + '</span></div>';
    }).join('');
  }

  function wireSplitter() {
    var dragging = false;
    dom.splitter.addEventListener('mousedown', function (event) {
      dragging = true;
      dom.splitter.classList.add('is-dragging');
      document.body.style.cursor = 'col-resize';
      event.preventDefault();
    });
    window.addEventListener('mousemove', function (event) {
      if (!dragging) { return; }
      var rect = dom.panes.getBoundingClientRect();
      state.config.splitRatio = clamp((event.clientX - rect.left) / rect.width, 0.15, 0.85);
      applySplitRatio();
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) { return; }
      dragging = false;
      dom.splitter.classList.remove('is-dragging');
      document.body.style.cursor = '';
      saveConfig();
    });
  }

  // ------------------------------------------------------------------- 启动

  async function boot() {
    cacheDom();
    wire();
    buildShortcutList();

    var info = await hostCall('ready');
    state.config = normalizeConfig(info && info.config);
    // 专注模式是临时的视图状态。恢复它会让用户一启动就又回到他们正想摆脱的
    // 无边框窗口里。
    state.config.focusMode = false;
    state.dataDir = (info && info.dataDir) || '';
    state.frameColor = (info && info.frameColor) || '';
    setTreeRoots(state.config.folders && state.config.folders.length
      ? state.config.folders
      : (state.config.lastFolder ? [state.config.lastFolder] : []));

    // 窗口的置顶标志不会在重启后保留，因此在这里把保存的选择重新应用到窗口上。
    dom.btnTopmost.classList.toggle('is-on', !!state.config.topmost);
    if (state.config.topmost) {
      hostCall('window', { action: 'topmost', on: true }).catch(function () {});
    }

    dom.dataDir.textContent = state.dataDir;

    if (info && info.maximized) {
      dom.winMaxIcon.querySelector('use').setAttribute('href', '#i-restore');
      dom.winMax.title = '还原';
    }

    applyConfig();
    selectSidebarPanel(state.config.sidebarTab, false);

    if (info && info.args) {
      await openPath(info.args);
    } else {
      await restoreSession();
    }

    // 正常启动会精确恢复上次打开的内容——那些标签以及其中处于激活状态的那个，
    // 不会在它们前面再打开任何东西。只有在无可恢复时（首次运行，或退出前关闭了所有
    // 标签），窗口才会以空文档启动——欢迎页取消之后，这就是此时的落点状态。
    if (!state.tabs.length) {
      activateTab(makeTab({ text: '' }).id);
    }

    updateWindowTitle();

    // 启动开销主要花在加载前端上，因此记录每个资源的到达耗时。
    var timings = performance.getEntriesByType('resource').map(function (entry) {
      return entry.name.split('/').pop() + '=' + Math.round(entry.duration);
    });
    hostCall('log', { line: 'boot: assets ' + timings.join(' ') }).catch(function () {});

  }

  window.addEventListener('DOMContentLoaded', function () {
    boot().catch(function (error) {
      // 启动失败是最难排查的一类问题：把调用栈留在日志里。
      hostCall('log', {
        line: 'boot failed: ' + String(error && error.message) + '\n' +
          String((error && error.stack) || '').split('\n').slice(0, 6).join('\n'),
      }).catch(function () {});
      document.body.innerHTML = '<div style="padding:40px;font:14px sans-serif">' +
        'cNote 启动失败：' + String(error && error.message) + '</div>';
    });
  });
})();

