import https from "https";
import http from "http";
import fs from "fs";

const SECURED = "https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx/secured";
const DA = "E:BranchReadinessLevel=CBB&amp;OSArchitecture=AMD64&amp;App=WU&amp;InstallationType=Client&amp;AppVer=10.0.17134.471&amp;OSVersion=10.0.17134.472&amp;DeviceFamily=Windows.Desktop";

function get(url, headers = {}) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0", ...headers } }, r => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => res(d));
    }).on("error", rej);
  });
}
function soapBody(id, rev) {
  return `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing"><s:Header><a:Action s:mustUnderstand="1">http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService/GetExtendedUpdateInfo2</a:Action><a:MessageID>urn:uuid:a68d4c75-ab85-4ca8-87db-136d281a2e28</a:MessageID><a:To s:mustUnderstand="1">${SECURED}</a:To><o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><Created>2019-01-01T00:00:00.000Z</Created><Expires>2100-01-01T00:00:00.000Z</Expires></Timestamp><wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization"><TicketType Name="AAD" Version="1.0" Policy="MBI_SSL"/></wuws:WindowsUpdateTicketsToken></o:Security></s:Header><s:Body><GetExtendedUpdateInfo2 xmlns="http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService"><updateIDs><UpdateIdentity><UpdateID>${id}</UpdateID><RevisionNumber>${rev}</RevisionNumber></UpdateIdentity></updateIDs><infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType></infoTypes><deviceAttributes>${DA}</deviceAttributes></GetExtendedUpdateInfo2></s:Body></s:Envelope>`;
}
function post(b) {
  return new Promise((res, rej) => {
    const r = https.request(SECURED, { method: "POST", headers: { "Content-Type": "application/soap+xml; charset=utf-8", "User-Agent": "Windows-Update-Agent/10.0.10011.16384 Client-Protocol/1.81" } }, rs => {
      let d = ""; rs.on("data", c => d += c); rs.on("end", () => res(d));
    });
    r.on("error", rej); r.write(b); r.end();
  });
}
function head(url) {
  return new Promise(res => {
    const lib = url.startsWith("https") ? https : http;
    const r = lib.request(url, { method: "HEAD" }, rs => res({ status: rs.statusCode, lm: rs.headers["last-modified"] }));
    r.on("error", e => res({ err: e.message })); r.end();
  });
}
const deco = s => s.replace(/&amp;/g, "&");

function verFromMoniker(m) {
  const p = m.split("_"); if (p.length < 2) return null;
  const ver = p[1], arch = p[2] || "x64", c = ver.split(".");
  let disp = ver;
  if (c.length === 4) { const [a, b, raw] = [+c[0], +c[1], +c[2]]; if (![a, b, raw].some(isNaN)) disp = `${a}.${b}.${Math.floor(raw / 100)}.${raw % 100}`; }
  return { disp, arch };
}

async function resolveDate(uid) {
  // revision 1 first; a few fallbacks if the first revision has no file
  for (const rev of [1, 2, 3]) {
    let xml;
    try { xml = await post(soapBody(uid, rev)); } catch { continue; }
    const urls = [...xml.matchAll(/<Url>(.*?)<\/Url>/g)].map(m => deco(m[1]));
    const u = urls.find(x => x.includes("tlu.dl.delivery")) || urls.find(x => x.includes("dl.delivery")) || urls[0];
    if (!u) continue;
    const h = await head(u);
    if (h.lm) return Math.floor(new Date(h.lm).getTime() / 1000);
  }
  return null;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (true) { const idx = i++; if (idx >= items.length) break; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

(async () => {
  // 1. Build merged UWP list (JSON + TXT), dedupe by updateId, x64, Release+Preview.
  const rows = [];
  try {
    const j = JSON.parse(await get("https://www.raythnetwork.co.uk/versions.php?type=json", { Accept: "application/json" }));
    for (const r of j) {
      if (r.length < 3) continue;
      const kind = r[2] === "0" ? "Release" : r[2] === "2" ? "Preview" : null;
      if (!kind) continue;
      if ((r[3] || "x64").toLowerCase() !== "x64") continue;
      rows.push({ kind, short: (r[0] || "").trim(), uid: (r[1] || "").trim() });
    }
  } catch (e) { console.error("JSON db err", e.message); }
  try {
    const t = await get("https://www.raythnetwork.co.uk/versions.php?type=txt");
    let cur = "Release";
    for (let ln of t.split(/\r?\n/)) {
      ln = ln.trim(); if (!ln) continue;
      if (ln === "Releases") { cur = "Release"; continue; }
      if (ln === "Beta") { cur = "Beta"; continue; }
      if (ln === "Preview") { cur = "Preview"; continue; }
      if (cur === "Beta") continue;
      const sp = ln.split(" "); if (sp.length < 2) continue;
      const v = verFromMoniker(sp[1]); if (!v) continue;
      if ((v.arch || "x64").toLowerCase() !== "x64") continue;
      rows.push({ kind: cur, short: v.disp, uid: sp[0] });
    }
  } catch (e) { console.error("TXT db err", e.message); }

  const seen = new Set(), list = [];
  for (const r of rows) { if (!r.short || !r.uid || seen.has(r.uid)) continue; seen.add(r.uid); list.push(r); }
  console.error(`merged unique UWP versions: ${list.length}`);

  // 2. Resolve each via FE3 -> Last-Modified (concurrency 6).
  let done = 0;
  const results = await pool(list, 6, async (r) => {
    const ts = await resolveDate(r.uid);
    done++; if (done % 20 === 0) console.error(`  ${done}/${list.length}`);
    return { ...r, ts };
  });

  // 3. Output.
  const ok = results.filter(r => r.ts);
  const fail = results.filter(r => !r.ts);
  ok.sort((a, b) => b.ts - a.ts);

  const byUpdateId = {};
  const readable = [];
  for (const r of ok) {
    byUpdateId[r.uid] = r.ts;
    readable.push({ version: r.short, kind: r.kind, date: new Date(r.ts * 1000).toISOString().slice(0, 10), timestamp: r.ts, updateId: r.uid });
  }
  // Embedded data consumed by versiondb.rs: compact { updateId: unixSeconds }.
  // Run from the project root: `node --use-system-ca scripts/fetch-uwp-dates.mjs`
  fs.writeFileSync("src-tauri/src/uwp_dates.json", JSON.stringify(byUpdateId));
  console.error(`resolved: ${ok.length}, failed: ${fail.length} -> src-tauri/src/uwp_dates.json`);
  if (fail.length) console.error("failed versions:", fail.map(f => f.short).join(", "));
  // print a small preview
  console.error("preview (newest 6):");
  readable.slice(0, 6).forEach(r => console.error(`  ${r.version}  ${r.date}  (${r.kind})`));
})();
