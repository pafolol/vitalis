// Prints docs/brief/brief.html to docs/Vitalis-Project-Brief.pdf (A4) and reports the page count.
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(pathToFileURL(resolve('docs/brief/brief.html')).href, { waitUntil: 'networkidle' });
await p.pdf({ path: 'docs/Vitalis-Project-Brief.pdf', format: 'A4', printBackground: true, preferCSSPageSize: true });
await b.close();
