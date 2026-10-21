import type { Locator } from "@playwright/test";

/** Bring an element to the top of its own scroll container (not the window: the app shell must stay where it is in a screenshot). */
export async function scrollToTop(el: Locator, margin = 16): Promise<void> {
  await el.evaluate((node, m) => {
    let p = node.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    if (p) p.scrollTop += node.getBoundingClientRect().top - p.getBoundingClientRect().top - m;
    window.scrollTo(0, 0);
  }, margin);
}
