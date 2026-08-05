<script lang="ts">
  let {
    orientation,
    label,
    value,
    minimum,
    maximum,
    onDelta,
    onReset,
  }: {
    orientation: "vertical" | "horizontal";
    label: string;
    value: number;
    minimum: number;
    maximum: number;
    onDelta: (delta: number) => void;
    onReset: () => void;
  } = $props();

  let activePointer = $state<number | null>(null);
  let lastCoordinate = 0;

  function pointerDown(event: PointerEvent): void {
    activePointer = event.pointerId;
    lastCoordinate = orientation === "vertical" ? event.clientX : event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function pointerMove(event: PointerEvent): void {
    if (activePointer !== event.pointerId) return;
    const coordinate = orientation === "vertical" ? event.clientX : event.clientY;
    onDelta(coordinate - lastCoordinate);
    lastCoordinate = coordinate;
  }

  function pointerEnd(event: PointerEvent): void {
    if (activePointer !== event.pointerId) return;
    activePointer = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }

  function keyDown(event: KeyboardEvent): void {
    const step = event.shiftKey ? 48 : 16;
    const delta =
      orientation === "vertical"
        ? event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : 0
        : event.key === "ArrowUp"
          ? -step
          : event.key === "ArrowDown"
            ? step
            : 0;
    if (delta === 0) return;
    event.preventDefault();
    onDelta(delta);
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class:vertical={orientation === "vertical"}
  class:horizontal={orientation === "horizontal"}
  class:active={activePointer !== null}
  class="resize-handle"
  role="separator"
  aria-label={label}
  aria-orientation={orientation}
  aria-valuemin={minimum}
  aria-valuemax={maximum}
  aria-valuenow={value}
  tabindex="0"
  onpointerdown={pointerDown}
  onpointermove={pointerMove}
  onpointerup={pointerEnd}
  onpointercancel={pointerEnd}
  onkeydown={keyDown}
  ondblclick={onReset}
></div>

<style>
  .resize-handle {
    position: relative;
    z-index: 8;
    flex: none;
    background: var(--border);
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    transition: background 160ms ease-out;
    touch-action: none;
  }

  .resize-handle::after {
    position: absolute;
    content: "";
  }

  .vertical {
    width: 5px;
    cursor: col-resize;
  }

  .vertical::after {
    inset: 0 -4px;
  }

  .horizontal {
    width: 100%;
    height: 5px;
    cursor: row-resize;
  }

  .horizontal::after {
    inset: -4px 0;
  }

  .resize-handle:hover,
  .resize-handle:focus-visible,
  .resize-handle.active {
    background: var(--accent);
    outline: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .resize-handle {
      transition: none;
    }
  }
</style>
