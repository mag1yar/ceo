import { Handle, Position } from "@xyflow/react"

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left]

// Shown on hover and on the node a connection starts from; the pseudo-element widens the hit area.
const DOT =
  "size-2.5! min-h-0! min-w-0! rounded-full border border-primary bg-background! opacity-0 transition-[opacity,scale] duration-(--duration-fast) ease-out before:absolute before:-inset-1.5 before:content-[''] hover:scale-125 [[aria-roledescription=node]:hover_&]:opacity-100 [[aria-roledescription=node]:has(.connectingfrom,.clickconnecting)_&]:opacity-100 motion-reduce:transition-none motion-reduce:hover:scale-100"

// Covers the node only while connecting (React Flow enables pointer events then), so a drop lands anywhere on it.
const BODY =
  "inset-0! size-auto! min-h-0! min-w-0! transform-none! rounded-[inherit] border-0 bg-transparent! transition-shadow duration-(--duration-fast) ease-out [[aria-roledescription=node]:has(.connectingfrom,.clickconnecting)_&]:pointer-events-none! [&.connectingto]:ring-2 [&.connectingto]:ring-destructive [&.valid]:ring-primary"

// Ends float, so a dot only picks where a drag starts; any handle on the target takes the drop.
export function NodeHandles() {
  return (
    <>
      <Handle
        type="target"
        id="body"
        position={Position.Top}
        isConnectableStart={false}
        className={BODY}
      />
      {SIDES.map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={side}
          className={DOT}
        />
      ))}
    </>
  )
}
