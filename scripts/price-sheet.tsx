// The price sheet: public/prepweek-price-sheet.pdf, linked from the pricing
// section, for anyone who needs prices as a document (a purchase approval,
// Paddle's review). Made from the same plans as the site, so run this again
// when they change:
//
//   bun scripts/price-sheet.tsx            (uses `chromium` on the PATH)
//   CHROME=/path/to/chrome bun scripts/price-sheet.tsx

import { renderToStaticMarkup } from 'react-dom/server';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { COMPANY } from '../src/lib/company.ts';
import { FREE_PEOPLE, PAID_PLANS, PLAN_INCLUDES } from '../src/lib/plans.ts';
import { Logo, Wordmark } from '../src/ui/brand.tsx';

const OUT = 'public/prepweek-price-sheet.pdf';
const font = (file: string) => `url(${Bun.pathToFileURL(resolve('public/fonts', file)).href})`;
const updated = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const eur = (n: number) => `€${n.toLocaleString('en-GB')}`;

const rows = [
  { name: 'Free', people: FREE_PEOPLE, month: 0, year: 0 },
  ...PAID_PLANS.map((p) => ({ name: p.name, people: p.people, month: p.month, year: p.year })),
];

const Sheet = () => (
  <main>
    <header>
      <span className="brand">
        <Logo size={30} />
        <Wordmark size={30} />
      </span>
      <span className="meta">
        Price sheet
        <br />
        {updated}
      </span>
    </header>

    <h1>Plan your team’s work, week by week.</h1>
    <p className="lead">
      Prepweek is an online team planner. Everyone’s work sits on one shared timeline: drag a block onto a person, stretch it over the days it
      takes, and the whole team sees the change live, on desktop and phone. Plans are priced by how many people you plan for; every plan has
      every feature.
    </p>

    <h2>Plans</h2>
    <table>
      <thead>
        <tr>
          <th>Plan</th>
          <th>People planned</th>
          <th>Monthly</th>
          <th>Yearly</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>
              <b>{r.name}</b>
            </td>
            <td>Up to {r.people}</td>
            <td>{r.month ? `${eur(r.month)} / month` : 'Free'}</td>
            <td>{r.year ? `${eur(r.year)} / year` : 'Free'}</td>
          </tr>
        ))}
        <tr className="custom">
          <td>
            <b>Larger teams</b>
          </td>
          <td>More than {PAID_PLANS.at(-1)!.people}</td>
          <td colSpan={2}>Quoted on request: support@prepweek.com</td>
        </tr>
      </tbody>
    </table>
    <p className="note">
      Prices in euro, per workspace; Paddle works out VAT or sales tax for your country at checkout. Yearly billing costs ten months: two months free. A person is a
      row you plan for, not a login: anyone you share with can sign in and view at no cost.
    </p>

    <h2>Included in every plan</h2>
    <ul>
      {PLAN_INCLUDES.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>

    <h2>Billing, cancelling and refunds</h2>
    <ul>
      <li>Subscriptions are sold by Paddle.com, our merchant of record, who handles payment, invoices and VAT.</li>
      <li>Plans renew each month or year. Cancel any time from the app: the plan stays until the end of the period you paid for.</li>
      <li>A full refund within 14 days of any payment, no questions asked.</li>
    </ul>

    <footer>
      <span>
        {COMPANY.name} · {COMPANY.address} · {COMPANY.number}
      </span>
      <span>prepweek.com · support@prepweek.com · prepweek.com/terms · prepweek.com/refunds</span>
    </footer>
  </main>
);

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Prepweek price sheet</title><style>
@font-face { font-family: Inter; src: ${font('inter-latin-wght-normal.woff2')} format('woff2'); font-weight: 100 900; }
@font-face { font-family: Inter; src: ${font('inter-latin-ext-wght-normal.woff2')} format('woff2'); font-weight: 100 900; unicode-range: U+0100-024F, U+20AC; }
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; }
body { font: 400 10.5pt/1.5 Inter, sans-serif; color: #3b3644; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
main { width: 210mm; height: 297mm; padding: 16mm 18mm 0; position: relative; }
header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 7mm; border-bottom: 1px solid #e6e3ea; color: #24202b; }
.brand { display: flex; align-items: center; gap: 9px; }
.meta { text-align: right; font-size: 9pt; color: #6a6573; line-height: 1.4; }
h1 { font-size: 22pt; line-height: 1.15; letter-spacing: -0.02em; color: #24202b; margin: 8mm 0 3mm; }
.lead { font-size: 11pt; margin: 0 0 4mm; max-width: 160mm; }
h2 { font-size: 12pt; color: #24202b; margin: 7mm 0 2.5mm; }
table { width: 100%; border-collapse: collapse; font-size: 10.5pt; }
th { text-align: left; font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #6a6573; padding: 0 3mm 2mm; border-bottom: 1px solid #e6e3ea; }
td { padding: 2.4mm 3mm; border-bottom: 1px solid #efedf2; }
td b { color: #24202b; font-weight: 650; }
tr.custom td { background: #f6f4f8; }
.note { font-size: 9pt; color: #6a6573; margin: 3mm 0 0; }
ul { margin: 0; padding-left: 5mm; }
li { margin: 0.6mm 0; }
li::marker { color: #d82d8c; }
footer { position: absolute; left: 18mm; right: 18mm; bottom: 12mm; padding-top: 4mm; border-top: 1px solid #e6e3ea; display: flex; flex-direction: column; gap: 1mm; font-size: 8.5pt; color: #6a6573; }
</style></head><body>${renderToStaticMarkup(<Sheet />)}</body></html>`;

const tmp = resolve(tmpdir(), 'prepweek-price-sheet.html');
await Bun.write(tmp, html);
const chrome = process.env.CHROME ?? 'chromium';
const run = Bun.spawnSync([chrome, '--headless', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${resolve(OUT)}`, Bun.pathToFileURL(tmp).href], { stderr: 'pipe' });
if (run.exitCode !== 0) throw new Error(`${chrome} failed: ${run.stderr.toString().slice(-400)}`);
console.log(`wrote ${OUT}`);
