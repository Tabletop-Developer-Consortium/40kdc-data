import { test, expect, type Page } from '@playwright/test';

const factionSelect = (page: Page) =>
	page.locator('label', { hasText: 'Faction' }).locator('select');

test('improves Necron Warriors with an attached leader and positional aura source', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('button', { name: '+ New list' }).click();
	await factionSelect(page).selectOption('necrons');

	await page.getByPlaceholder('Search units or keywords…').fill('Necron Warriors');
	await page.locator('li button').filter({ hasText: /^Necron Warriors/ }).first().click();
	const suggestions = page.locator('section', {
		has: page.getByRole('heading', { name: 'Improve this unit' }),
	});
	await expect(suggestions.getByText('Plasmancer · Harbinger of Destruction')).toBeVisible();
	await expect(suggestions.getByText('Illuminor Szeras · Mechanical Augmentation (Aura)')).toBeVisible();

	await suggestions.getByRole('button', { name: 'Add Plasmancer and attach' }).click();
	await page.getByRole('button', { name: /^Plasmancer attached/ }).click();
	const attachment = page.locator('label', { hasText: 'Attached to' }).locator('select');
	await expect(attachment.locator('option:checked')).toHaveText('Necron Warriors');
	await page.getByRole('button', { name: /^Necron Warriors ×10 leading/ }).click();

	await suggestions.getByRole('button', { name: 'Add Illuminor Szeras' }).click();
	await expect(page.getByText('Illuminor Szeras').first()).toBeVisible();
	await expect(suggestions.getByText('Position Illuminor Szeras within its aura.')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Necron Warriors' })).toBeVisible();
});
