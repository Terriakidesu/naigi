import { composerFormatShortcut, formatComposerSelection, type ComposerFormat } from "./composer-formatting";
import { iconElement, renderIcons } from "./icons";

export function setupComposerFormatToolbar(input: HTMLTextAreaElement) {
  const toolbar = document.createElement("div");
  toolbar.className = "composer-format-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Format selected text");
  toolbar.hidden = true;
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  const formats = [
    { format: "bold", label: "Bold", icon: "bold", shortcut: "B" },
    { format: "italic", label: "Italic", icon: "italic", shortcut: "I" },
    { format: "strike", label: "Strikethrough", icon: "strikethrough", shortcut: "Shift+X" },
    { format: "spoiler", label: "Spoiler", icon: "eye-off", shortcut: "Shift+S" },
  ] as const;
  let dismissed = "";
  const selection = () => `${input.selectionStart}:${input.selectionEnd}:${input.value}`;
  const hide = () => { toolbar.hidden = true; };
  const position = () => {
    const rect = input.getBoundingClientRect();
    const width = toolbar.getBoundingClientRect().width;
    toolbar.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))}px`;
    const height = toolbar.getBoundingClientRect().height;
    toolbar.style.top = `${rect.top >= height + 12 ? rect.top - height - 8 : rect.bottom + 8}px`;
  };
  const refresh = () => {
    const focused = document.activeElement === input || toolbar.contains(document.activeElement);
    if (!focused || input.disabled || input.readOnly || input.selectionStart === input.selectionEnd
      || !input.value.slice(input.selectionStart, input.selectionEnd).trim() || selection() === dismissed) { hide(); return; }
    toolbar.hidden = false;
    position();
  };
  const apply = (format: ComposerFormat) => {
    if (input.disabled || input.readOnly) return;
    const edit = formatComposerSelection(input.value, input.selectionStart, input.selectionEnd, format);
    if (input.maxLength >= 0 && edit.value.length > input.maxLength) return;
    input.focus();
    input.setSelectionRange(edit.from, edit.to);
    // Native insertion preserves the browser's undo stack; setRangeText is the fallback.
    if (!document.execCommand("insertText", false, edit.replacement)) input.setRangeText(edit.replacement, edit.from, edit.to, "end");
    input.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    dismissed = "";
    refresh();
  };
  for (const { format, label, icon, shortcut } of formats) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.format = format;
    button.title = `${label} (${modifier}+${shortcut})`;
    button.setAttribute("aria-label", button.title);
    button.setAttribute("aria-keyshortcuts", `${modifier === "⌘" ? "Meta" : "Control"}+${shortcut}`);
    button.append(iconElement(icon));
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => apply(format));
    toolbar.append(button);
  }
  document.body.append(toolbar);
  renderIcons(toolbar);
  input.addEventListener("keydown", (event) => {
    const format = composerFormatShortcut(event);
    if (format && !input.disabled && !input.readOnly) {
      event.preventDefault();
      if (!event.repeat) apply(format);
    } else if (event.key === "Escape" && !toolbar.hidden) {
      event.preventDefault();
      dismissed = selection();
      hide();
    }
  });
  toolbar.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismissed = selection();
      input.focus();
      hide();
    }
    const buttons = [...toolbar.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      buttons[(index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  });
  for (const name of ["select", "input", "focus", "keyup", "pointerup", "scroll"]) input.addEventListener(name, refresh);
  input.addEventListener("blur", (event) => { if (!toolbar.contains(event.relatedTarget as Node | null)) hide(); });
  toolbar.addEventListener("focusout", (event) => { if (event.relatedTarget !== input && !toolbar.contains(event.relatedTarget as Node | null)) hide(); });
  document.addEventListener("selectionchange", refresh);
  window.addEventListener("resize", refresh);
  window.addEventListener("scroll", refresh, true);
  new MutationObserver(refresh).observe(input, { attributes: true, attributeFilter: ["disabled", "readonly"] });
  return refresh;
}
