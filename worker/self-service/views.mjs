import aiSetup from "../../docs/ai-setup.md";
import selfHosting from "../../docs/self-hosting.md";
import qrcode from "qrcode-generator";
import start from "./ui/start.html";
import home from "./ui/home.html";
import homeCss from "./ui/home.css";
import heroPhone from "./ui/images/hero-phone.webp";
import flowReview from "./ui/images/flow-review.webp";
import flowDraft from "./ui/images/flow-draft.webp";
import flowSend from "./ui/images/flow-send.webp";
import account from "./ui/account.html";
import privacy from "./ui/privacy.html";
import terms from "./ui/terms.html";
import script from "./ui/app.js.txt";
import css from "./ui/style.css";
import faq from "./ui/faq.html";
import report from "./ui/report.html";
import quickstartPage from "./ui/quickstart.html";
import reportScript from "./ui/report.js.txt";
const homeImages = Object.freeze({
  "/self/assets/hero-phone.webp": heroPhone,
  "/self/assets/flow-review.webp": flowReview,
  "/self/assets/flow-draft.webp": flowDraft,
  "/self/assets/flow-send.webp": flowSend,
});

export function serveSelfPage(request, ctx = { env: {} }) {
  const path = new URL(request.url).pathname;
  let body, type;
  const helps = {
    "/self/help/ai-setup": aiSetup,
    "/self/help/self-hosting": selfHosting,
  };
  const supportPages = { '/self/help/faq': faq, '/self/help/report': report, '/self/help/quickstart': quickstartPage };
  const supportPage = Object.hasOwn(supportPages, path);
  const verificationFile = ctx.env.SELF_GOOGLE_SITE_VERIFICATION_FILE;
  if (
    typeof verificationFile === 'string' &&
    /^google[a-f0-9]{16}\.html$/.test(verificationFile) &&
    path === '/' + verificationFile
  ) {
    body = 'google-site-verification: ' + verificationFile;
    type = 'text/plain; charset=utf-8';
  } else if (path === "/") {
    body = home;
    type = "text/html; charset=utf-8";
  } else if (path === "/self/assets/home.css") {
    body = homeCss;
    type = "text/css; charset=utf-8";
  } else if (Object.hasOwn(homeImages, path)) {
    body = homeImages[path];
    type = "image/webp";
  } else if (supportPage) {
    body = supportPages[path];
    type = 'text/html; charset=utf-8';
  } else if (path === '/self/assets/report.js') {
    body = reportScript;
    type = 'text/javascript; charset=utf-8';
  } else if (path === "/self/privacy" || path === "/self/terms") {
    body = path === "/self/privacy" ? privacy : terms;
    type = "text/html; charset=utf-8";
  } else if (helps[path]) {
    body = helps[path];
    type = "text/plain; charset=utf-8";
  } else if (path === "/self/assets/line-qr.svg") {
    const url = ctx.env.SELF_LINE_FRIEND_URL;
    if (!url || !/^https:\/\//.test(url))
      return new Response(null, { status: 503 });
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    body = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    type = "image/svg+xml";
  } else if (
    ["/start", "/account"].includes(path) ||
    /^\/account\/replies\/ss_[\w-]+$/.test(path)
  ) {
    body = path === "/start" ? start : account;
    type = "text/html; charset=utf-8";
  } else if (path === "/self/assets/app.js") {
    body = script;
    type = "text/javascript; charset=utf-8";
  } else if (path === "/self/assets/style.css") {
    body = css;
    type = "text/css; charset=utf-8";
  } else return null;
  if (request.method !== "GET") return new Response(null, { status: 405 });
  return new Response(body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": path === "/"
        ? "default-src 'none'; script-src 'none'; style-src 'self'; img-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        : supportPage
        ? "default-src 'self'; script-src 'self'; connect-src 'none'; frame-src 'none'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        : "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}
