// @vitest-environment happy-dom
import { expect, test } from "vitest"
import { accelerator, COMMANDS, isTyping, keys, matches } from "./registry"

test("every command has a unique id and every shortcut belongs to one command", () => {
  const ids = COMMANDS.map((c) => c.id)
  expect(new Set(ids).size).toBe(ids.length)
  const shortcuts = COMMANDS.flatMap((c) => c.shortcuts ?? []).map((s) =>
    JSON.stringify(s)
  )
  expect(new Set(shortcuts).size).toBe(shortcuts.length)
  // No keystroke may match two commands.
  for (const c of COMMANDS)
    for (const s of c.shortcuts ?? []) {
      const e = new KeyboardEvent("keydown", {
        code: s.code,
        metaKey: !!s.meta,
        shiftKey: !!s.shift,
      })
      const hits = COMMANDS.filter((x) =>
        x.shortcuts?.some((y) => matches(y, e))
      )
      expect(hits.map((x) => x.id)).toEqual([c.id])
    }
})

test("shortcuts match the physical key, so non-Latin layouts work", () => {
  const cmdK = { code: "KeyK", meta: true }
  const russian = new KeyboardEvent("keydown", {
    code: "KeyK",
    key: "л",
    metaKey: true,
  })
  expect(matches(cmdK, russian)).toBe(true)
  // Ctrl+B stays the tmux prefix.
  const ctrl = new KeyboardEvent("keydown", {
    code: "KeyK",
    metaKey: true,
    ctrlKey: true,
  })
  expect(matches(cmdK, ctrl)).toBe(false)
})

test("keycaps and menu accelerators", () => {
  expect(keys({ code: "BracketRight", meta: true, shift: true })).toEqual([
    "⌘",
    "⇧",
    "]",
  ])
  expect(keys({ code: "Digit1", shift: true })).toEqual(["⇧", "1"])
  expect(accelerator({ code: "KeyK", meta: true })).toBe("Cmd+KeyK")
  expect(accelerator({ code: "BracketLeft", meta: true, shift: true })).toBe(
    "Cmd+Shift+BracketLeft"
  )
  // A bare key in the menu would fire while typing.
  expect(accelerator({ code: "KeyN" })).toBeUndefined()
})

test("the typing guard covers inputs, textareas, contenteditable and the terminal", () => {
  document.body.innerHTML = `
    <input id="rename" />
    <textarea id="note"></textarea>
    <div contenteditable="true"><p id="rich">text</p></div>
    <div class="xterm"><textarea class="xterm-helper-textarea" id="term"></textarea></div>
    <button id="button">ok</button>
    <div id="board" tabindex="0"></div>`
  for (const id of ["rename", "note", "rich", "term"])
    expect(isTyping(document.getElementById(id)), id).toBe(true)
  for (const id of ["button", "board"])
    expect(isTyping(document.getElementById(id)), id).toBe(false)
  expect(isTyping(document.body)).toBe(false)
  expect(isTyping(null)).toBe(false)
})
