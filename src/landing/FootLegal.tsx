import { COMPANY } from '../lib/company.ts';

/** The footer's second line: who runs Prepweek, and the policies. */
export const FootLegal = () => (
  <div className="lp-wrap">
    <div className="lp-foot-legal">
      <span>
        © {new Date().getFullYear()} {COMPANY.name}
      </span>
      <span className="lp-foot-links">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/refunds">Refunds</a>
      </span>
    </div>
  </div>
);
