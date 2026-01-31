/**
 * CSS Patch Strategy.
 *
 * Attempts to fix z-index / occlusion issues by injecting CSS overrides
 * directly into the page. This is used in "dream" simulations to test
 * whether a CSS-level fix would resolve the visual regression.
 *
 * In production, this would translate to a hotfix deployment or a
 * runtime style injection via feature flag.
 */

export interface CssPatchResult {
  applied: boolean;
  patchCss: string;
  detail: string;
}

/**
 * Injects CSS into a Playwright page to neutralize a blocking overlay.
 * Used within dream simulations only — never applied directly to production.
 */
export async function applyCssPatch(
  page: any,
  blockingSelector?: string
): Promise<CssPatchResult> {
  // Strategy 1: If we know the blocking element, target it directly
  if (blockingSelector) {
    const patchCss = `${blockingSelector} { pointer-events: none !important; z-index: -1 !important; }`;
    try {
      await page.addStyleTag({ content: patchCss });
      return {
        applied: true,
        patchCss,
        detail: `Neutralized blocking element: ${blockingSelector}`,
      };
    } catch (error: any) {
      return {
        applied: false,
        patchCss,
        detail: `Failed to apply targeted patch: ${error?.message}`,
      };
    }
  }

  // Strategy 2: Blanket fix — disable pointer events on common overlay patterns
  const blanketCss = `
    [id*="overlay"], [class*="overlay"], [id*="modal"], [class*="modal"],
    [data-testid="ghost-overlay"] {
      pointer-events: none !important;
      z-index: -1 !important;
    }
  `;

  try {
    await page.addStyleTag({ content: blanketCss });
    return {
      applied: true,
      patchCss: blanketCss.trim(),
      detail: "Applied blanket overlay neutralization",
    };
  } catch (error: any) {
    return {
      applied: false,
      patchCss: blanketCss.trim(),
      detail: `Failed to apply blanket patch: ${error?.message}`,
    };
  }
}

/**
 * Removes the blocking element from the DOM entirely.
 * More aggressive than CSS patch — used as a diagnostic step in dreams.
 */
export async function removeBlockingElement(
  page: any,
  blockingSelector?: string
): Promise<{ removed: boolean; detail: string }> {
  const selector = blockingSelector ?? '[data-testid="ghost-overlay"]';

  try {
    const removed = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel);
      if (el) {
        el.remove();
        return true;
      }
      return false;
    }, selector);

    return {
      removed,
      detail: removed
        ? `Removed element matching: ${selector}`
        : `No element found matching: ${selector}`,
    };
  } catch (error: any) {
    return {
      removed: false,
      detail: `Failed to remove element: ${error?.message}`,
    };
  }
}
