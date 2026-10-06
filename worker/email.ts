// HTML for the emails we send (sign-in links, invites). Email clients only
// render a subset of HTML/CSS reliably, so this is a table layout with inline
// styles, a light theme, and the link also written out in case the button
// doesn't render.

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const ACCENT = '#4f5bd5';

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
<body style="margin:0;padding:0;background:#f3f4f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f7;">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
        <tr>
          <td style="padding:0 4px 18px;font-family:${FONT};font-size:17px;font-weight:700;color:#14161c;letter-spacing:-0.01em;">
            <img src="${origin}/icons/email-logo.png" width="160" height="26" alt="PrepWeek" style="display:block;width:160px;height:26px;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:17px;font-weight:700;color:#14161c;">
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;border:1px solid #e6e8ee;border-radius:14px;padding:32px 32px 28px;font-family:${FONT};color:#14161c;">
            <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;font-weight:650;letter-spacing:-0.01em;">${heading}</h1>
            ${paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#3b3f4a;">${p}</p>`).join('\n            ')}
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 24px;">
              <tr>
                <td style="border-radius:9px;background:${ACCENT};">
                  <a href="${button.href}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:9px;">${button.label}</a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:12.5px;line-height:1.5;color:#7a8091;">Or paste this link into your browser:<br><a href="${button.href}" style="color:${ACCENT};word-break:break-all;">${button.href}</a></p>
          </td>
        </tr>
        <tr>
          <td style="padding:18px 8px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:#8a90a0;text-align:center;">${footer}</td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
