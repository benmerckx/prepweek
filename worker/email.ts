// HTML for the emails we send (sign-in links, invites). Email clients only
// render a subset of HTML/CSS reliably, so this is a table layout with inline
// styles, a light theme, and the link also written out in case the button
// doesn't render.

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
/** Buttons: warm ink. Links: rust. */
const ACCENT = '#26222d';
const LINK = '#c23c63';

interface Email {
  /** The app's address, where the logo image is served. */
  origin: string;
  /** Shown as the preview line in the inbox. */
  preheader: string;
  heading: string;
  /** Paragraphs, already escaped where they contain user input. */
  paragraphs: string[];
  button: { href: string; label: string };
  /** Small print under the button. */
  footer: string;
}

export const renderEmail = ({ origin, preheader, heading, paragraphs, button, footer }: Email) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#f5f3f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f7;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
        <tr>
          <td style="padding:0 4px 18px;font-family:${FONT};font-size:17px;font-weight:700;color:#221f28;letter-spacing:-0.01em;">
            <img src="${origin}/icons/email-logo.png" width="149" height="24" alt="Prepweek" style="display:block;width:149px;height:24px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:17px;font-weight:700;color:#221f28;">
          </td>
        </tr>
        <tr>
          <td style="background:#fffeff;border:1px solid #e4e1e9;border-radius:14px;padding:32px 32px 28px;font-family:${FONT};color:#221f28;">
            <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-0.01em;">${heading}</h1>
            ${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#48434f;">${p}</p>`).join('\n            ')}
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 24px;">
              <tr>
                <td style="border-radius:9px;background:${ACCENT};">
                  <a href="${button.href}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:9px;">${button.label}</a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:12.5px;line-height:1.5;color:#8e8998;">Or paste this link into your browser:<br><a href="${button.href}" style="color:${LINK};word-break:break-all;">${button.href}</a></p>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:#8e8998;text-align:center;">${footer}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

export interface DigestSection {
  sheet: string;
  /** The sheet's address; items open with ?task=<id>. */
  href: string;
  today: { taskId: string; title: string; color: string; detail: string }[];
  next: { taskId: string; title: string; color: string; detail: string }[];
  updates: { taskId: string; title: string; color: string; detail: string }[];
  more: { today: number; next: number; updates: number };
}

interface Digest {
  origin: string;
  preheader: string;
  heading: string;
  intro: string;
  sections: DigestSection[];
  /** One click turns the digest off. */
  offHref: string;
}

const COLOR = /^#[0-9a-f]{3,8}$/i;

const digestList = (label: string, items: DigestSection['today'], more: number, href: string) =>
  !items.length
    ? ''
    : `<tr><td style="padding:16px 0 6px;font-family:${FONT};font-size:12px;font-weight:650;letter-spacing:0.04em;text-transform:uppercase;color:#8e8998;">${label}</td></tr>
${items
  .map(
    (i) => `<tr><td style="padding:5px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td width="4" style="width:4px;border-radius:2px;background:${COLOR.test(i.color) ? i.color : '#8b8d98'};">&nbsp;</td>
    <td style="padding:2px 0 2px 12px;font-family:${FONT};">
      <a href="${href}?task=${encodeURIComponent(i.taskId)}" style="font-size:15px;font-weight:600;color:#221f28;text-decoration:none;">${escapeHtml(i.title)}</a>
      <div style="font-size:13px;line-height:1.45;color:#66616f;">${escapeHtml(i.detail)}</div>
    </td>
  </tr></table>
</td></tr>`,
  )
  .join('\n')}${more ? `<tr><td style="padding:4px 0 0 16px;font-family:${FONT};font-size:13px;color:#8e8998;">and ${more} more</td></tr>` : ''}`;

export const renderDigest = ({ origin, preheader, heading, intro, sections, offHref }: Digest) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:#f5f3f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3f7;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
        <tr>
          <td style="padding:0 4px 18px;">
            <img src="${origin}/icons/email-logo.png" width="149" height="24" alt="Prepweek" style="display:block;width:149px;height:24px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:17px;font-weight:700;color:#221f28;">
          </td>
        </tr>
        <tr>
          <td style="background:#fffeff;border:1px solid #e4e1e9;border-radius:14px;padding:30px 30px 26px;font-family:${FONT};color:#221f28;">
            <h1 style="margin:0 0 6px;font-size:21px;line-height:1.3;font-weight:700;letter-spacing:-0.01em;">${heading}</h1>
            <p style="margin:0;font-size:15px;line-height:1.5;color:#66616f;">${intro}</p>
            ${sections
              .map(
                (s) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;border-top:1px solid #e4e1e9;">
              ${sections.length > 1 ? `<tr><td style="padding:16px 0 0;font-family:${FONT};font-size:16px;font-weight:700;"><a href="${s.href}" style="color:#221f28;text-decoration:none;">${escapeHtml(s.sheet)}</a></td></tr>` : ''}
              ${digestList('Today', s.today, s.more.today, s.href)}
              ${digestList('Next up', s.next, s.more.next, s.href)}
              ${digestList('Updates', s.updates, s.more.updates, s.href)}
            </table>`,
              )
              .join('\n            ')}
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 0;">
              <tr>
                <td style="border-radius:9px;background:${ACCENT};">
                  <a href="${sections[0]?.href ?? origin}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:9px;">Open Prepweek</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:#8e8998;text-align:center;">You get this on workday mornings when there’s something on your plate.<br><a href="${offHref}" style="color:#66616f;">Turn off the daily digest</a></td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
