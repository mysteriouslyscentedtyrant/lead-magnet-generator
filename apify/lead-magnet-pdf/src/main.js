// Lead Magnet PDF: turns one print-ready HTML document into a PDF.
// Input: { html }  ->  Output: PDF stored as the run's OUTPUT record (returned by run-sync).
//
// The HTML comes from a visitor's browser (through n8n), so it is treated as untrusted:
// - a Content-Security-Policy forbids every script and every request except fonts and embedded images,
// - all network requests are blocked except Google Fonts and data: URLs (embedded logo),
// - size and time are limited.
import { Actor } from 'apify';
import puppeteer from 'puppeteer';

const MAX_HTML_BYTES = 5 * 1024 * 1024;
const ALLOWED_REQUESTS = [/^data:/, /^about:blank$/, /^https:\/\/fonts\.googleapis\.com\//, /^https:\/\/fonts\.gstatic\.com\//];
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; "
  + "font-src https://fonts.gstatic.com data:; img-src data:; base-uri 'none'; form-action 'none'";

await Actor.init();

const input = (await Actor.getInput()) || {};
const html = typeof input.html === 'string' ? input.html : '';
if (!/^\s*<!doctype html/i.test(html) || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
  await Actor.fail('Input "html" must be a complete HTML document (starting with <!doctype html>) under 5 MB.');
}

// Put the security policy first in <head>, before anything else is read.
const safeHtml = html.replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}<meta http-equiv="Content-Security-Policy" content="${CSP}">`);

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (ALLOWED_REQUESTS.some((re) => re.test(request.url()))) request.continue();
    else request.abort('blockedbyclient');
  });
  await page.setContent(safeHtml, { waitUntil: 'networkidle0', timeout: 45000 });
  await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, timeout: 60000 });
  await Actor.setValue('OUTPUT', pdf, { contentType: 'application/pdf' });
  console.log(`PDF created: ${Math.round(pdf.length / 1024)} KB`);
} finally {
  await browser.close();
}

await Actor.exit();
