import { PlusIcon } from "@phosphor-icons/react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test } from "vitest"

import { Button } from "./button"

test("button renders a phosphor icon", () => {
  const html = renderToStaticMarkup(
    <Button>
      <PlusIcon data-icon="inline-start" />
      Add
    </Button>
  )
  expect(html).toContain('data-slot="button"')
  expect(html).toContain("<svg")
})
