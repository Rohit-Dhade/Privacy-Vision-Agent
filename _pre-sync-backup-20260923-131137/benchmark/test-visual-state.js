/**
 * Standalone, verbose test for utils/visualStateEngine.js.
 *
 * benchmark/run-benchmark.js scores the same scenes as pass/fail for the
 * published report; this file prints the underlying measurements
 * (contrast gaps, band spreads, change ratios) so the thresholds can be
 * re-tuned against evidence rather than guessed at. Scenes come from the
 * shared fixture module so the two never drift apart.
 *
 * Run: node benchmark/test-visual-state.js
 */
const VSE = require('../Browser-Agent/utils/visualStateEngine.js');
const S = require('./fixtures/visual-state-scenes.js');
const {
  blank, clone, rect, normalPage, pageWithSpinner, pageWithDropdown,
  differentPage, pageWithModal, darkThemedPage, lightPageWithDarkChrome,
  darkPageWithModal, scrolledPage
} = S;
const W = S.W, H = S.H;

// ── Assertions ─────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(name, cond, info = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${info}`); }
}

console.log('\n=== compareFrames ===');
{
  const page = normalPage();
  const identical = VSE.compareFrames(page, clone(page));
  check('identical frames => no_change', identical.verdict === 'no_change', JSON.stringify(identical));

  const dropdown = VSE.compareFrames(page, pageWithDropdown());
  check('dropdown opened => localized_change', dropdown.verdict === 'localized_change',
    `verdict=${dropdown.verdict} ratio=${dropdown.changeRatio.toFixed(4)}`);
  check('dropdown bounds located near the dropdown',
    dropdown.changedBounds && dropdown.changedBounds.y >= 160,
    JSON.stringify(dropdown.changedBounds));

  const nav = VSE.compareFrames(page, differentPage());
  check('navigation => major_change', nav.verdict === 'major_change',
    `verdict=${nav.verdict} ratio=${nav.changeRatio.toFixed(4)}`);

  const resized = VSE.compareFrames(page, blank(400, 260));
  check('viewport resize => major_change, not comparable',
    resized.verdict === 'major_change' && resized.comparable === false);
}

console.log('\n=== detectLoadingIndicator ===');
{
  const a = pageWithSpinner(0);
  const b = pageWithSpinner(90);
  const spin = VSE.detectLoadingIndicator(a, b);
  check('rotating spinner => isLoading', spin.isLoading === true,
    `reason=${spin.reason} ratio=${spin.changeRatio.toFixed(4)} edges=${spin.edgeDensity.toFixed(3)}`);
  check('spinner region is compact',
    spin.region && spin.region.width <= 64 && spin.region.height <= 64,
    JSON.stringify(spin.region));

  const still = VSE.detectLoadingIndicator(normalPage(), clone(normalPage()));
  check('static page => not loading', still.isLoading === false, still.reason);

  const navigated = VSE.detectLoadingIndicator(normalPage(), differentPage());
  check('full navigation => not a spinner', navigated.isLoading === false, navigated.reason);
  check('...and the reason is change_too_large', navigated.reason === 'change_too_large', navigated.reason);

  // A dropdown is localized but should NOT be mistaken for a spinner in a
  // single comparison: it is a state change, not a sustained animation.
  // We accept either outcome here but report it, since this is the known
  // ambiguity that two-frame differencing alone cannot fully resolve.
  const dd = VSE.detectLoadingIndicator(normalPage(), pageWithDropdown());
  console.log(`  INFO  dropdown-vs-spinner ambiguity: isLoading=${dd.isLoading} reason=${dd.reason} ratio=${dd.changeRatio.toFixed(4)}`);
}

console.log('\n=== detectBlockingOverlay ===');
{
  const fmt = (r) => `gap=${r.contrastGap.toFixed(1)} spread=${r.bandSpread.toFixed(1)} ` +
                     `permVar=${r.perimeterVariance.toFixed(0)} drop=${r.perimeterDrop.toFixed(1)} conf=${r.confidence}`;

  const normal = VSE.detectBlockingOverlay(normalPage());
  check('normal page => no overlay', normal.hasBlockingOverlay === false, fmt(normal));

  const modal = VSE.detectBlockingOverlay(pageWithModal());
  check('modal + scrim => overlay detected', modal.hasBlockingOverlay === true, fmt(modal));
  check('modal reports a dialog region', !!modal.dialogRegion, JSON.stringify(modal.dialogRegion));

  // The false-positive trap this detector was redesigned around.
  const dark = VSE.detectBlockingOverlay(darkThemedPage());
  check('dark-themed page => NOT a false positive', dark.hasBlockingOverlay === false, fmt(dark));

  // Very common real layout: light body, dark nav bar and dark footer.
  const darkChrome = VSE.detectBlockingOverlay(lightPageWithDarkChrome());
  check('light page w/ dark header+footer => NOT a false positive',
    darkChrome.hasBlockingOverlay === false, fmt(darkChrome));

  // A scrim over a DARK page must still be caught.
  const darkModal = VSE.detectBlockingOverlay(darkPageWithModal());
  check('modal over a dark-themed page => detected',
    darkModal.hasBlockingOverlay === true, fmt(darkModal));

  const empty = VSE.detectBlockingOverlay(blank());
  check('blank white page => no overlay', empty.hasBlockingOverlay === false, fmt(empty));

  console.log('  -- temporal path --');
  const appearing = VSE.detectBlockingOverlay(pageWithModal(), normalPage());
  check('modal appearing between frames => high confidence',
    appearing.hasBlockingOverlay === true && appearing.confidence === 'high', fmt(appearing));

  const stillDark = VSE.detectBlockingOverlay(darkThemedPage(), darkThemedPage());
  check('dark theme in both frames => still no overlay',
    stillDark.hasBlockingOverlay === false, fmt(stillDark));

  const scrolled = VSE.detectBlockingOverlay(scrolledPage(), normalPage());
  check('page scrolled => not mistaken for a modal',
    scrolled.hasBlockingOverlay === false, fmt(scrolled));
}

console.log('\n=== verifyElementPainted ===');
{
  const page = normalPage();
  const button = VSE.verifyElementPainted(page, { x: 16, y: 165, width: 70, height: 20 });
  check('rendered button => painted', button.painted === true,
    `var=${button.variance.toFixed(1)} edges=${button.edgeDensity.toFixed(3)}`);

  const blankArea = VSE.verifyElementPainted(page, { x: 230, y: 100, width: 60, height: 30 });
  check('featureless area => not painted', blankArea.painted === false,
    `var=${blankArea.variance.toFixed(1)} edges=${blankArea.edgeDensity.toFixed(3)}`);

  const tiny = VSE.verifyElementPainted(page, { x: 10, y: 10, width: 2, height: 2 });
  check('sub-3px box => fails open (painted, not confident)',
    tiny.painted === true && tiny.confident === false, JSON.stringify(tiny));

  const textArea = VSE.verifyElementPainted(page, { x: 16, y: 40, width: 200, height: 40 });
  check('text block => painted', textArea.painted === true,
    `var=${textArea.variance.toFixed(1)}`);
}

console.log('\n=== analyzeScreenState + deriveVisualDecision ===');
{
  const report = VSE.analyzeScreenState(pageWithSpinner(90), pageWithSpinner(0), [
    { elementId: 'btn-1', box: { x: 16, y: 165, width: 70, height: 20 } },
    { elementId: 'ghost-1', box: { x: 230, y: 100, width: 60, height: 30 } }
  ]);
  check('report marks loading', report.isLoading === true, JSON.stringify(report.frameDelta));
  check('report lists the unpainted element only',
    report.unpaintedElementIds.length === 1 && report.unpaintedElementIds[0] === 'ghost-1',
    JSON.stringify(report.unpaintedElementIds));

  const d1 = VSE.deriveVisualDecision(report, 'click');
  check('loading => wait decision', d1 && d1.action === 'wait', JSON.stringify(d1));

  const page = normalPage();
  const noChangeReport = VSE.analyzeScreenState(clone(page), page, []);
  const d2 = VSE.deriveVisualDecision(noChangeReport, 'click');
  check('click that changed nothing => flag_ineffective_action',
    d2 && d2.action === 'flag_ineffective_action', JSON.stringify(d2));

  const modalReport = VSE.analyzeScreenState(pageWithModal(), null, []);
  const d3 = VSE.deriveVisualDecision(modalReport, null);
  check('modal => constrain_to_dialog', d3 && d3.action === 'constrain_to_dialog', JSON.stringify(d3));

  const calmReport = VSE.analyzeScreenState(pageWithDropdown(), page, []);
  const d4 = VSE.deriveVisualDecision(calmReport, 'click');
  check('successful click (page changed) => no intervention', d4 === null, JSON.stringify(d4));

  check('null input => no decision', VSE.deriveVisualDecision(null, 'click') === null);
  check('unanalyzed report => no decision',
    VSE.deriveVisualDecision({ analyzed: false }, 'click') === null);
}

console.log('\n=== performance sanity (1280x800) ===');
{
  const big = blank(1280, 800);
  for (let i = 0; i < 400; i++) rect(big, (i * 37) % 1200, (i * 53) % 760, 40, 8, [60, 60, 70]);
  const big2 = clone(big);
  rect(big2, 600, 400, 24, 24, [10, 10, 10]);
  const t0 = Date.now();
  VSE.analyzeScreenState(big2, big, [{ elementId: 'e', box: { x: 10, y: 10, width: 80, height: 30 } }]);
  const ms = Date.now() - t0;
  check(`full analysis under 250ms on 1280x800 (actual ${ms}ms)`, ms < 250, `${ms}ms`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
