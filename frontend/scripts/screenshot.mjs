// 以 headless Chromium 擷取頁面，供無瀏覽器環境驗證前端。
// Capture a page with headless Chromium to verify the frontend without a browser.
//   node scripts/screenshot.mjs URL OUT.png [CSS_SELECTOR] [--wait=MS] [--width=PX]
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const options = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')))
const [url, out, selector] = args.filter((a) => !a.startsWith('--'))
if (!url || !out) {
  console.error('usage: node scripts/screenshot.mjs URL OUT.png [CSS_SELECTOR] [--wait=MS] [--width=PX]')
  process.exit(2)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: Number(options.width ?? 1440), height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(Number(options.wait ?? 1500))
  const target = selector ? page.locator(selector).first() : page
  await target.screenshot({ path: out, ...(selector ? {} : { fullPage: true }) })
  if (selector) console.log((await page.locator(selector).first().innerText()).trim())
  for (const error of errors) console.error('page error:', error)
} finally {
  await browser.close()
}
