import { BroadcastIcon } from "@phosphor-icons/react"
import { emit } from "@tauri-apps/api/event"
import { Button } from "@workspace/ui/components/button"
import { Panel, useReactFlow } from "@xyflow/react"
import { BUS_EVENT, type Message, type MessageKind } from "./messages"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Dev builds only: plays a scripted conversation over `bus://message` until the real bus (#19) exists.
export function DemoSignals({ projectId }: { projectId: string }) {
  const rf = useReactFlow()
  const play = async () => {
    const nodes = rf.getNodes()
    const ceo = nodes.find((n) => n.type === "ceo")?.id
    const lead = nodes.find((n) => n.type === "lead")?.id
    const members = nodes.filter((n) => n.type === "member").map((n) => n.id)
    if (!ceo || !lead || members.length < 2) {
      console.warn(
        "demo signals need a CEO, a Lead and two members: seed a team"
      )
      return
    }
    const run = Date.now().toString(36)
    const step = async (
      id: string,
      from: string,
      to: string,
      kind: MessageKind,
      thread = id
    ) => {
      const m: Message = {
        id: `${run}-${id}`,
        projectId,
        from,
        to,
        thread: `${run}-${thread}`,
        kind,
        state: "sent",
        sentAt: Date.now(),
      }
      await emit(BUS_EVENT, m)
      return {
        waiting: () =>
          emit(BUS_EVENT, { ...m, state: "waiting", waitingAt: Date.now() }),
        accept: () =>
          emit(BUS_EVENT, { ...m, state: "accepted", acceptedAt: Date.now() }),
      }
    }
    const [a, b] = members
    const send = await step("send", ceo, lead, "send")
    await wait(1300)
    await send.waiting()
    await wait(1500)
    await send.accept()
    const reports = [
      await step("r1", a, lead, "report"),
      await step("r2", b, lead, "report"),
      await step("r3", a, lead, "report"),
    ]
    await wait(1300)
    for (const r of reports) await r.waiting()
    await wait(2500)
    for (const r of reports) await r.accept()
    const ask = await step("ask", b, lead, "ask")
    await wait(1300)
    await ask.waiting()
    await wait(1500)
    await ask.accept()
    await wait(1500)
    const reply = await step("reply", lead, b, "reply", "ask")
    await wait(1300)
    await reply.waiting()
    await wait(1200)
    await reply.accept()
    const direct = await step("direct", a, ceo, "send")
    await wait(1300)
    await direct.waiting()
    await wait(2000)
    await direct.accept()
  }
  return (
    <Panel position="top-center">
      <Button variant="outline" size="sm" onClick={play}>
        <BroadcastIcon />
        Demo signals
      </Button>
    </Panel>
  )
}
