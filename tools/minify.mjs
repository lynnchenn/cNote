// 在把某个前端文件嵌入可执行文件之前先把它压小。
//
//   node minify.mjs <输入> <输出>
//
// esbuild 是可选的：前端是写给人读的，因此不装它也能构建出可用的可执行文件，
// 只是体积大约多 35 KB。若最在意二进制体积，可以安装：
//
//   npm install --prefix tools esbuild

import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  process.stderr.write('usage: node minify.mjs <input> <output>\n');
  process.exit(2);
}

// 只压缩这三种文本类型。其余内容——比如 logo 位图——都是逐字节复制的：
// 把 PNG 当作 utf8 解码会把每个非法序列换成 U+FFFD，发布出去的图片就悄悄损坏了。
const loader = input.endsWith('.js') ? 'js' : input.endsWith('.css') ? 'css' : null;
if (!loader && !input.endsWith('.html')) {
  writeFileSync(output, readFileSync(input));
  process.exit(0);
}

const source = readFileSync(input, 'utf8');

let esbuild = null;
if (loader || input.endsWith('.html')) {
  try {
    esbuild = await import('esbuild');
  } catch {
    process.stderr.write(`minify: esbuild not installed, embedding ${input} as written\n`);
  }
}

if (!esbuild) {
  writeFileSync(output, source);
} else if (input.endsWith('.html')) {
  // 外壳文件以标记为主，esbuild 不会压缩标记，因此这里只做它能做的两件事：
  // 去掉注释，并像其他脚本那样压缩内联的启动脚本。标记中的空白保持原样——
  // 行内元素之间的空白是有意义的。
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '');
  const pattern = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g;
  let html = '';
  let at = 0;
  for (let match = pattern.exec(withoutComments); match; match = pattern.exec(withoutComments)) {
    html += withoutComments.slice(at, match.index) + match[1];
    html += match[2].trim()
      ? (await esbuild.transform(match[2], { loader: 'js', minify: true, legalComments: 'none' })).code.trim()
      : match[2];
    html += match[3];
    at = match.index + match[0].length;
  }
  writeFileSync(output, html + withoutComments.slice(at));
} else {
  // 除压缩器的默认行为外不做名称混淆：前端依赖少数几个必须保留名称的全局对象
  // （Markdown、Highlight、MathML），而 esbuild 对非模块脚本不会改动顶层名称。
  const result = await esbuild.transform(source, {
    loader,
    minify: true,
    legalComments: 'none',
  });
  writeFileSync(output, result.code);
}
