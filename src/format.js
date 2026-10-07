const ICON = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' };
const COLOR = { pass: 32, warn: 33, fail: 31, info: 36 };

/**
 * Human-readable report.
 * @param {ReturnType<import('./checks.js').evaluate>} report
 * @param {{ color?: boolean }} [opts]
 */
export function formatText(report, opts = {}) {
  const c = (code, s) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const bold = (s) => c(1, s);
  const dim = (s) => c(2, s);
  const out = [];

  out.push(bold(`AI search readiness: ${report.finalUrl}`));
  const gradeColor = report.score >= 75 ? COLOR.pass : report.score >= 50 ? COLOR.warn : COLOR.fail;
  out.push(`Score ${c(gradeColor, bold(`${report.score}/100 (${report.grade})`))}  ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail${report.summary.blockers ? c(COLOR.fail, ` (${report.summary.blockers} blocker${report.summary.blockers > 1 ? 's' : ''}: score capped at 39)`) : ''}`);
  out.push('');

  for (const ch of report.checks) {
    out.push(`${c(COLOR[ch.status], `[${ICON[ch.status]}]`)} ${bold(ch.label)}: ${ch.detail}`);
    if (ch.fix) out.push(`       ${dim('fix:')} ${ch.fix}`);
  }

  out.push('');
  out.push(bold('AI crawlers vs. robots.txt (homepage)'));
  const w = Math.max(...report.crawlers.map((x) => x.token.length));
  const pw = Math.max(...report.crawlers.map((x) => x.purpose.length));
  for (const x of report.crawlers) {
    const state = x.allowed ? c(COLOR.pass, 'allowed') : c(x.purpose === 'training' ? COLOR.info : COLOR.fail, 'blocked');
    const why = x.rule ? dim(` ${x.rule}${x.group ? ` [group: ${x.group}]` : ''}`) : x.group ? dim(` [group: ${x.group}]`) : '';
    out.push(`  ${x.token.padEnd(w)}  ${x.purpose.padEnd(pw)}  ${state}${why}`);
  }
  out.push('');
  out.push(dim('Technical readiness only: this does not measure whether AI engines actually cite you.'));
  return out.join('\n');
}
