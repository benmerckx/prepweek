// Keeps the title of a block readable when the block starts left of the
// visible area, by shifting its label right.
//
// CSS `position: sticky` does this too, but hundreds of sticky elements in
// one scroller cost the main thread several ms on every scroll frame. Here a
// scroll only does a numeric pass over the mounted blocks and touches the DOM
// for the handful that actually cross the left edge.

const MIN_VISIBLE = 64;

interface Item {
  label: HTMLElement;
  left: number;
  width: number;
  off: number;
}

export class LabelPinner {
  private items = new Map<HTMLElement, Item>();
  private edge = 0;

  register(el: HTMLElement, left: number, width: number) {
    const label = el.querySelector<HTMLElement>('.task-label');
    if (!label) return;
    const item = this.items.get(el);
    if (item && item.label === label) {
      item.left = left;
      item.width = width;
    } else {
      this.items.set(el, { label, left, width, off: 0 });
    }
    this.apply(this.items.get(el)!);
  }

  unregister(el: HTMLElement) {
    this.items.delete(el);
  }

  /** `edge` is the body x coordinate of the visible left edge. */
  update(edge: number) {
    this.edge = edge;
    for (const item of this.items.values()) this.apply(item);
  }

  private apply(item: Item) {
    const raw = this.edge - item.left;
    const off = raw <= 0 ? 0 : Math.min(raw, Math.max(0, item.width - MIN_VISIBLE));
    if (off === item.off) return;
    item.off = off;
    item.label.style.transform = off ? `translateX(${off}px)` : '';
  }
}

export const labelPinner = new LabelPinner();
