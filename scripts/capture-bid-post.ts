/**
 * One-off helper: opens a bid form, fills minimal fields, clicks submit,
 * and prints the captured POST payload from the browser network.
 *
 * Usage: npx tsx scripts/capture-bid-post.ts [job-slug]
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { PLATFORM } from '../lib/platform-config.ts';
import { attachBidPostCapture, readBidPageContext } from '../lib/workana-bid-api.ts';

dotenv.config();

const DB_FILE = path.join(process.cwd(), 'db.json');
const slug = process.argv[2] || 'criacao-site-44';

async function main() {
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  const profileDir = path.resolve(PLATFORM.profileDir);
  const browser = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome'
  });

  const page = await browser.newPage();
  const capture = attachBidPostCapture(page);

  const bidUrl = `${PLATFORM.baseUrl}/messages/bid/${slug}`;
  await page.goto(bidUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const ctx = await readBidPageContext(page);
  console.log('\n=== Bid page context ===');
  console.log(JSON.stringify(ctx, null, 2));

  const textarea = page.locator('textarea[name="bid[content]"], textarea[name="bid[message]"], textarea').first();
  await textarea.fill('Teste de captura de POST — não enviar de verdade se possível cancelar.');

  const price = page.locator('bid-index input[inputmode="decimal"], bid-index input[type="tel"]').first();
  if (await price.isVisible().catch(() => false)) {
    await price.fill('150');
  }

  console.log('\nClique manualmente em Enviar proposta se o script não achar o botão.');
  const submit = page.locator('button:has-text("Enviar proposta"), button[type="submit"]').first();
  if (await submit.isVisible().catch(() => false)) {
    await submit.click({ timeout: 5000 }).catch(() => {});
  }

  await page.waitForTimeout(8000);

  const last = capture.getLastCapture();
  console.log('\n=== Captured POST ===');
  console.log(JSON.stringify(last, null, 2));

  capture.dispose();
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
