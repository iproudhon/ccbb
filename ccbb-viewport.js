'use strict';
// The phone's viewport sync, shared by ccbb-mobile.js's app and the mux page's phone
// embed (ccbb-mux-web.js). A script, as a string, for an inline <script>: no backticks,
// no template holes, and backslashes doubled where the code itself has one.
const VIEWPORT_JS = `
// ── viewport ──────────────────────────────────────────────────────────────────
// Follow both dimensions of the visible viewport. Safari can pan it while focusing
// an editor; forcing document scroll back to zero fights that movement. Fixed surfaces
// share its origin instead, keeping their bottom edge at the keyboard.
// ttn serves ccbb in a same-origin iframe. Its own visualViewport stays at the
// iframe's layout size when the keyboard opens; only the outer window sees it.
// Read the highest accessible viewport, without changing the host page or frame.
var viewportWindow = window, viewportFrames = [];
try {
  while (viewportWindow.parent !== viewportWindow && viewportWindow.frameElement) {
    var viewportFrame = viewportWindow.frameElement;
    var viewportParent = viewportWindow.parent;
    void viewportParent.document.documentElement;
    viewportFrames.push(viewportFrame);
    viewportWindow = viewportParent;
  }
} catch(e) {} // Cross-origin hosts must resize their frame themselves.
function mobileViewport(){
  var vv = viewportWindow.visualViewport;
  var top = vv ? vv.offsetTop : 0;
  var bottom = top + (vv ? vv.height : viewportWindow.innerHeight);
  // Translate the visible rectangle into each child viewport, clipping at its edges.
  for (var i = viewportFrames.length - 1; i >= 0; i--) {
    var frame = viewportFrames[i];
    // Safari focus scrolling can report a root-fixed iframe at -scrollY even
    // though its layout anchor is still top:0. Subtracting that rect from the
    // visual offset counts the same pan twice (396 - -396 = 792 on iPhone).
    // offsetTop preserves the layout anchor. Frames with a containing block or
    // normal document flow still need their current viewport-relative rect.
    var fixedToRoot = frame.ownerDocument.defaultView.getComputedStyle(frame).position === 'fixed' && !frame.offsetParent;
    var origin = (fixedToRoot ? frame.offsetTop : frame.getBoundingClientRect().top) + frame.clientTop;
    top = Math.max(0, Math.min(frame.clientHeight, top - origin));
    bottom = Math.max(top, Math.min(frame.clientHeight, bottom - origin));
  }
  return { height: bottom - top, offsetTop: top, scale: vv ? vv.scale : 1 };
}
var vvMax = {};
// What else follows the viewport: the phone app's terminal and its //vp readout.
var viewportHooks = [];
function keyboardUp(){
  var vv = viewportWindow.visualViewport;
  if (!vv) return false;
  // Layout width is stable through focus zoom and fractional viewport rounding.
  var w = viewportWindow.document.documentElement.clientWidth;
  vvMax[w] = Math.max(vvMax[w] || 0, vv.height);
  return vvMax[w] - vv.height > 150;
}
function syncViewport(){
  var vv = mobileViewport();
  if (vv.scale > 1.01) return;
  var doc = document.documentElement;
  // env(safe-area-inset-*) is 0 inside an iframe. A same-origin host that knows its own
  // inset hands it over on the frame element (zdte: data-safe-b), and --safe-b takes it.
  var safeB = viewportFrames.length && viewportFrames[0].getAttribute('data-safe-b');
  if (safeB && /^\\d+(\\.\\d+)?px$/.test(safeB)) doc.style.setProperty('--safe-b', safeB);
  var kb = keyboardUp();
  // Keyboard down in our own window: the CSS fallbacks (top 0, --full-h) are the screen. The
  // visual viewport is followed only while the keyboard is up, and always in a host's iframe
  // (ttn), whose own 100dvh is the frame's layout size.
  if (!kb && viewportWindow === window) {
    doc.style.removeProperty('--app-h');
    doc.style.removeProperty('--app-top');
  } else {
    doc.style.setProperty('--app-h', vv.height+'px');
    doc.style.setProperty('--app-top', vv.offsetTop+'px');
  }
  // With the keyboard up the composer sits right on it: the home-indicator inset and
  // the status footer under the composer belong to the screen's edge, and the keyboard
  // is covering that edge (see body.kb).
  document.body.classList.toggle('kb', kb);
  for (var h = 0; h < viewportHooks.length; h++) viewportHooks[h]();
}
// Recheck while focused and through keyboard dismissal, covering missed events
// during keyboard animations. Terminal fitting skips unchanged geometry.
var vvPoll = null, vvPollEnd = null;
function vvPollStart(){
  clearTimeout(vvPollEnd);
  if (!vvPoll) vvPoll = setInterval(syncViewport, 150);
  syncViewport();
}
function vvPollStop(){
  clearTimeout(vvPollEnd);
  vvPollEnd = setTimeout(function(){ clearInterval(vvPoll); vvPoll = null; syncViewport(); }, 800);
}
document.addEventListener('focusin', vvPollStart);
document.addEventListener('focusout', vvPollStop);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
}
// Parent viewport events do not propagate into iframe documents.
if (viewportWindow !== window) {
  if (viewportWindow.visualViewport) {
    viewportWindow.visualViewport.addEventListener('resize', syncViewport);
    viewportWindow.visualViewport.addEventListener('scroll', syncViewport);
  }
  viewportWindow.addEventListener('resize', syncViewport);
  viewportWindow.addEventListener('scroll', syncViewport, true);
  window.addEventListener('pagehide', function(e){
    if (e.persisted) return;
    if (viewportWindow.visualViewport) {
      viewportWindow.visualViewport.removeEventListener('resize', syncViewport);
      viewportWindow.visualViewport.removeEventListener('scroll', syncViewport);
    }
    viewportWindow.removeEventListener('resize', syncViewport);
    viewportWindow.removeEventListener('scroll', syncViewport, true);
  });
}
window.addEventListener('resize', syncViewport);
window.addEventListener('orientationchange', function(){ setTimeout(syncViewport, 250); });
syncViewport();
`;

module.exports = { VIEWPORT_JS };
