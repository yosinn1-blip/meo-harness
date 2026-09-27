import quickstart from "../../docs/quickstart.md";
import aiSetup from "../../docs/ai-setup.md";
import selfHosting from "../../docs/self-hosting.md";
import qrcode from "qrcode-generator";
import start from "./ui/start.html";
import account from "./ui/account.html";
import privacy from "./ui/privacy.html";
import terms from "./ui/terms.html";
import script from "./ui/app.js.txt";
import css from "./ui/style.css";
import faq from "./ui/faq.html";
import report from "./ui/report.html";
import reportScript from "./ui/report.js.txt";
export function serveSelfPage(request, ctx = { env: {} }) {
  const path = new URL(request.url).pathname;
  let body, type;
  const helps = {
    "/self/help/quickstart": quickstart,
    "/self/help/ai-setup": aiSetup,
    "/self/help/self-hosting": selfHosting,
  };
  const supportPage = path === '/self/help/faq' || path === '/self/help/report';
  if (supportPage) {
    body = path === '/self/help/faq' ? faq : report;
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
      "Content-Security-Policy": supportPage
        ? "default-src 'self'; script-src 'self'; connect-src 'none'; frame-src 'none'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        : "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    },
  });
}
