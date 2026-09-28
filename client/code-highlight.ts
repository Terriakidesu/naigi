export type CodeTokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "literal" | "function" | "type" | "property" | "tag" | "attribute" | "operator" | "punctuation" | "addition" | "deletion" | "diff-meta";

export type CodeToken = { kind: CodeTokenKind; value: string };

const MAX_HIGHLIGHT_TOKENS = 20_000;

const aliases: Record<string, string> = {
  cc: "cpp", cxx: "cpp", h: "c", hpp: "cpp", html: "markup", svg: "markup", xml: "markup", vue: "markup",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", rb: "ruby", rs: "rust", sh: "shell", bash: "shell", yml: "yaml", mdown: "markdown",
};

const languageKeywords: Record<string, Set<string>> = {
  c: new Set("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Bool _Complex _Imaginary".split(" ")),
  cpp: new Set("alignas alignof and asm auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or private protected public register return short signed sizeof static static_assert struct switch template this throw try typedef typename union unsigned using virtual void volatile while".split(" ")),
  java: new Set("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while".split(" ")),
  javascript: new Set("as async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield".split(" ")),
  typescript: new Set("abstract any as asserts async await bigint boolean break case catch class const constructor continue debugger declare default delete do else enum export extends finally for from function get if implements import infer in instanceof interface is keyof let module namespace never new number object of package private protected public readonly require global return set static string super switch symbol this throw try type typeof undefined unique unknown var void while with yield".split(" ")),
  python: new Set("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(" ")),
  ruby: new Set("alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield".split(" ")),
  go: new Set("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var".split(" ")),
  rust: new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" ")),
  php: new Set("abstract and array as break callable case catch class clone const continue declare default die do echo else elseif empty endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or parent print private protected public require require_once return static switch throw trait try unset use var while xor yield".split(" ")),
  sql: new Set("add all alter and any as asc begin between by case cascade check column commit constraint create cross current_date current_time database default delete desc distinct drop else end except exists false fetch foreign from full grant group having in index inner insert intersect into is join key left like limit not null offset on or order outer primary references right rollback row select set table then true union unique update values view when where with".split(" ")),
};

const literals = new Set("false null none nil true undefined nan inf infinity".split(" "));
const codeLanguages = new Set([
  ...Object.keys(languageKeywords), "css", "json", "markup", "shell", "yaml", "toml", "ini", "env", "conf",
]);
const cLikeLanguages = new Set(["c", "cpp", "java", "javascript", "typescript", "go", "rust", "php", "css"]);
const hashCommentLanguages = new Set(["python", "ruby", "shell", "yaml", "toml", "ini", "env", "conf"]);

function canonicalLanguage(language: string) {
  const normalized = language.trim().toLowerCase().replace(/^language-/, "");
  return aliases[normalized] ?? normalized;
}

function stringEnd(source: string, start: number, quote: string, allowTriple = false) {
  const triple = allowTriple && source.startsWith(quote.repeat(3), start);
  const delimiter = triple ? quote.repeat(3) : quote;
  let index = start + delimiter.length;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source.startsWith(delimiter, index)) return index + delimiter.length;
    if (!triple && source[index] === "\n") return index;
    index += 1;
  }
  return source.length;
}

function tokenizeDiff(source: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let start = 0;
  while (start < source.length && tokens.length < MAX_HIGHLIGHT_TOKENS - 1) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    const line = source.slice(start, end);
    const kind: CodeTokenKind = line.startsWith("+++") || line.startsWith("---") || line.startsWith("\\")
      ? "diff-meta"
      : line.startsWith("+") ? "addition"
        : line.startsWith("-") ? "deletion"
          : line.startsWith("@@") ? "diff-meta" : "plain";
    tokens.push({ kind, value: line });
    start = end;
  }
  if (start < source.length) tokens.push({ kind: "plain", value: source.slice(start) });
  return tokens;
}

export function tokenizeCode(source: string, language: string): CodeToken[] {
  const lang = canonicalLanguage(language);
  if (lang === "diff" || lang === "patch") return tokenizeDiff(source);
  if (!codeLanguages.has(lang)) return source ? [{ kind: "plain", value: source }] : [];

  const tokens: CodeToken[] = [];
  const markup = lang === "markup";
  let index = 0;
  let plainStart = 0;
  let insideMarkupTag = false;
  const markupTagPattern = /<\/?[A-Za-z][A-Za-z0-9:_-]*|<!DOCTYPE/iy;
  const numberPattern = /(?:0[xX][\da-fA-F]+|0[bB][01]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?n?)/y;
  const wordPattern = lang === "css" || lang === "yaml" ? /[A-Za-z_$][A-Za-z0-9_$-]*/y : /[A-Za-z_$][A-Za-z0-9_$]*/y;
  const operatorPattern = /(?:===|!==|=>|==|!=|<=|>=|\+\+|--|&&|\|\||\+=|-=|\*=|\/=|::|->|\.\.\.)/y;

  const nextNonWhitespace = (start: number) => {
    let cursor = start;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    return source[cursor];
  };

  const emit = (kind: CodeTokenKind, end: number) => {
    if (plainStart < index) tokens.push({ kind: "plain", value: source.slice(plainStart, index) });
    if (index < end) tokens.push({ kind, value: source.slice(index, end) });
    index = end;
    plainStart = end;
  };

  while (index < source.length && tokens.length < MAX_HIGHLIGHT_TOKENS) {
    if (markup && source.startsWith("<!--", index)) {
      const close = source.indexOf("-->", index + 4);
      emit("comment", close < 0 ? source.length : close + 3);
      continue;
    }
    if (markup) {
      markupTagPattern.lastIndex = index;
      const tag = markupTagPattern.exec(source);
      if (tag) {
        insideMarkupTag = true;
        emit("tag", markupTagPattern.lastIndex);
        continue;
      }
      if (insideMarkupTag && source.startsWith("/>", index)) {
        insideMarkupTag = false;
        emit("punctuation", index + 2);
        continue;
      }
      if (insideMarkupTag && source[index] === ">") {
        insideMarkupTag = false;
        emit("punctuation", index + 1);
        continue;
      }
      if (!insideMarkupTag) {
        index += 1;
        continue;
      }
    }

    if (source.startsWith("/*", index) && (cLikeLanguages.has(lang) || lang === "sql")) {
      const close = source.indexOf("*/", index + 2);
      emit("comment", close < 0 ? source.length : close + 2);
      continue;
    }
    if ((source.startsWith("//", index) && cLikeLanguages.has(lang))
      || (source.startsWith("--", index) && lang === "sql")
      || (source[index] === "#" && hashCommentLanguages.has(lang))) {
      const newline = source.indexOf("\n", index);
      emit("comment", newline < 0 ? source.length : newline);
      continue;
    }

    const quote = source[index];
    if ((quote === "'" || quote === "\"" || quote === "`") && lang !== "diff" && lang !== "patch") {
      const end = stringEnd(source, index, quote, lang === "python" || lang === "ruby");
      const jsonKey = lang === "json" && nextNonWhitespace(end) === ":";
      emit(jsonKey ? "property" : "string", end);
      continue;
    }

    if (/[0-9]/.test(source[index]) || source[index] === "." && /[0-9]/.test(source[index + 1] ?? "")) {
      numberPattern.lastIndex = index;
      const number = numberPattern.exec(source);
      if (number) {
        emit("number", numberPattern.lastIndex);
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(source[index])) {
      wordPattern.lastIndex = index;
      const wordMatch = wordPattern.exec(source)!;
      const word = wordMatch[0];
      const end = wordPattern.lastIndex;
      const afterWord = nextNonWhitespace(end);
      const lower = word.toLowerCase();
      let kind: CodeTokenKind = "plain";
      if (markup && insideMarkupTag && afterWord === "=") kind = "attribute";
      else if ((lang === "css" || lang === "yaml" || lang === "toml" || lang === "ini" || lang === "env" || lang === "conf")
        && (afterWord === ":" || ["toml", "ini", "env", "conf"].includes(lang) && afterWord === "=")) kind = "property";
      else if (languageKeywords[lang]?.has(word)) kind = "keyword";
      else if (literals.has(lower) || lang === "python" && ["false", "true", "none"].includes(lower)) kind = "literal";
      else if (!markup && afterWord === "(") kind = "function";
      else if (word.length > 1 && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) kind = "type";
      emit(kind, end);
      continue;
    }

    operatorPattern.lastIndex = index;
    const operator = operatorPattern.exec(source);
    if (operator) {
      emit("operator", operatorPattern.lastIndex);
      continue;
    }
    if ("{}()[].,;:".includes(source[index])) {
      emit("punctuation", index + 1);
      continue;
    }
    if ("=+-*/%<>!&|^~?@".includes(source[index])) {
      emit("operator", index + 1);
      continue;
    }
    index += 1;
  }

  if (plainStart < source.length) tokens.push({ kind: "plain", value: source.slice(plainStart) });
  return tokens;
}

export function renderHighlightedCode(target: HTMLElement, source: string, language: string) {
  const fragment = document.createDocumentFragment();
  for (const token of tokenizeCode(source, language)) {
    if (token.kind === "plain") {
      fragment.append(document.createTextNode(token.value));
      continue;
    }
    const span = document.createElement("span");
    span.className = `code-token-${token.kind}`;
    span.textContent = token.value;
    fragment.append(span);
  }
  target.replaceChildren(fragment);
}
