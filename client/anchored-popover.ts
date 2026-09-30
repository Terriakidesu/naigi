export function showAnchoredPopover(popover: HTMLElement, anchor: HTMLElement, onClose?: () => void, beside = false) {
  const anchorRect = anchor.getBoundingClientRect();
  popover.setAttribute("popover", "auto");
  const parentPopover = anchor.closest<HTMLElement>("[popover]");
  (parentPopover?.matches(":popover-open") ? parentPopover : document.body).append(popover);
  popover.showPopover();
  const position = () => {
    const rect = anchor.isConnected && anchor.getClientRects().length ? anchor.getBoundingClientRect() : anchorRect;
    const width = popover.getBoundingClientRect().width;
    const height = popover.getBoundingClientRect().height;
    const fitsBeside = beside && (rect.left >= width + 14 || rect.right + width + 14 <= innerWidth);
    const left = fitsBeside ? rect.left >= width + 14 ? rect.left - width - 6 : rect.right + 6
      : Math.max(8, Math.min(innerWidth - width - 8, rect.right - width));
    const top = fitsBeside ? Math.max(8, Math.min(innerHeight - height - 8, rect.top))
      : rect.bottom + height + 6 <= innerHeight - 8 ? rect.bottom + 6 : Math.max(8, rect.top - height - 6);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  };
  position();
  window.addEventListener("resize", position);
  const closed = (event: Event) => {
    if ((event as ToggleEvent).newState !== "closed") return;
    window.removeEventListener("resize", position);
    popover.removeEventListener("toggle", closed);
    popover.remove();
    onClose?.();
  };
  popover.addEventListener("toggle", closed);
}
