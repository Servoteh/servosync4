import type { Locator, Page } from '@playwright/test';

/**
 * Popuni polje po vidljivom `FormField` labelu (label NIJE vezan preko htmlFor —
 * pa idemo label → roditeljski div → input/textarea unutar njega).
 */
export async function fillByLabel(scope: Page | Locator, label: string, value: string): Promise<void> {
  const input = scope
    .locator(`label:has-text(${JSON.stringify(label)})`)
    .locator('xpath=..')
    .locator('input, textarea')
    .first();
  await input.fill(value);
}
