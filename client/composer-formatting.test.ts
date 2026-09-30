import { expect, test } from "bun:test";
import { composerFormatShortcut, formatComposerSelection } from "./composer-formatting";

test("formats a selection and toggles markers outside or inside it", () => {
  const edit = formatComposerSelection("hello world", 6, 11, "bold");
  expect(edit.value).toBe("hello **world**");
  expect([edit.selectionStart, edit.selectionEnd]).toEqual([8, 13]);
  expect(formatComposerSelection(edit.value, 8, 13, "bold").value).toBe("hello world");
  expect(formatComposerSelection(edit.value, 6, 15, "bold").value).toBe("hello world");
});
test("uses supported Markdown markers and retains surrounding whitespace", () => {
  expect(formatComposerSelection(" hello ", 0, 7, "italic").value).toBe(" _hello_ ");
  expect(formatComposerSelection("hello", 0, 5, "strike").value).toBe("~~hello~~");
  expect(formatComposerSelection("hello", 0, 5, "spoiler").value).toBe("||hello||");
  expect(formatComposerSelection("**hello**", 2, 7, "italic").value).toBe("**_hello_**");
});
test("inserts an empty pair with the caret inside when nothing is selected", () => {
  const edit = formatComposerSelection("hello", 5, 5, "bold");
  expect(edit.value).toBe("hello****");
  expect([edit.selectionStart, edit.selectionEnd]).toEqual([7, 7]);
});
test("wraps each nonempty line and removes line-wise formatting on toggle", () => {
  const text = "first\n\n second ";
  const edit = formatComposerSelection(text, 0, text.length, "spoiler");
  expect(edit.value).toBe("||first||\n\n ||second|| ");
  expect(formatComposerSelection(edit.value, 0, edit.value.length, "spoiler").value).toBe(text);
  expect(formatComposerSelection("**one**\n**two**", 0, 15, "bold").value).toBe("one\ntwo");
});
test("shortcuts require Ctrl or Meta and ignore composition and Alt", () => {
  const event = { key: "b", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false };
  expect(composerFormatShortcut(event)).toBe("bold");
  expect(composerFormatShortcut({ ...event, key: "i", ctrlKey: false, metaKey: true })).toBe("italic");
  expect(composerFormatShortcut({ ...event, key: "x", shiftKey: true })).toBe("strike");
  expect(composerFormatShortcut({ ...event, key: "s", shiftKey: true })).toBe("spoiler");
  for (const ignored of [{ ctrlKey: false }, { altKey: true }, { isComposing: true }, { shiftKey: true }, { key: "s" }]) {
    expect(composerFormatShortcut({ ...event, ...ignored })).toBeUndefined();
  }
});
