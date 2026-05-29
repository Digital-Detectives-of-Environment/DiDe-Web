#!/usr/bin/env node
"use strict";

/**
 * DiDe — Citizen Read Load Test Runner (HTTP only, no DB)
 *
 * Usage:  cd Artillery-Analysis && node run-citizen-test.js
 *
 * 7 Experiments — same POI, increasing VU/s:
 *   #1  10 VU/s   #4 60 VU/s   #7 100 VU/s
 *   #2  20 VU/s   #5 80 VU/s
 *   #3  40 VU/s   #6 100 VU/s
 */

const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(PROJECT_ROOT, ".env") });

const TARGET_URL = process.env.TARGET_URL || "http://localhost:3000";
const TEST_DUR   = parseInt(process.env.TEST_DURATION_SEC || "60", 10);
const RAMP_DUR   = parseInt(process.env.RAMP_DURATION_SEC || "15", 10);
const OUTPUTS    = path.join(__dirname, "outputs");
const YML_BASE   = path.join(__dirname, "citizen-load-test.yml");
const YML_RUN    = path.join(__dirname, ".citizen-run.yml");
const REPORT     = path.join(OUTPUTS, "citizen-summary-report.html");

const VU_STEPS = [10, 20, 40, 60, 80, 100, 100];

// ── Get public POI count via HTTP ───────────────────────────────
function getPublicPOI() {
  const http = TARGET_URL.startsWith("https") ? require("https") : require("http");
  return new Promise(resolve => {
    const req = http.get(`${TARGET_URL}/api/events_all`, { timeout: 15000 }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { const a = JSON.parse(d); resolve(Array.isArray(a) ? a.length : 0); } catch { resolve(0); }
      });
    });
    req.on("error", () => resolve(0));
    req.on("timeout", () => { req.destroy(); resolve(0); });
  });
}

// ── Build & run artillery ───────────────────────────────────────
function buildYaml(vu) {
  const base = fs.readFileSync(YML_BASE, "utf-8");
  const sc = base.substring(base.match(/^scenarios:/m).index);
  const cfg = `config:\n  target: "${TARGET_URL}"\n  http:\n    timeout: 30000\n    pool: 100\n  phases:\n    - name: "Warm-up"\n      duration: ${RAMP_DUR}\n      arrivalRate: 1\n      rampTo: ${vu}\n    - name: "Sustained Load"\n      duration: ${TEST_DUR}\n      arrivalRate: ${vu}\n    - name: "Cool-down"\n      duration: 10\n      arrivalRate: ${vu}\n      rampTo: 1\n  defaults:\n    headers:\n      Accept: "application/json"\n  plugins:\n    metrics-by-endpoint: {}\n  processor: "./citizen-processor.js"\n\n`;
  fs.writeFileSync(YML_RUN, cfg + sc, "utf-8");
}

function runArtillery(num, vu) {
  const out = path.join(OUTPUTS, `citizen-exp-${num}.json`);
  console.log(`\n   [TEST] Artillery starting (${vu} VU/s, ${TEST_DUR}s)...`);
  buildYaml(vu);
  try {
    execSync(`npx artillery run "${YML_RUN}" --output "${out}"`, { stdio: "inherit", cwd: __dirname, env: process.env });
    return out;
  } catch (e) {
    console.error(`   [TEST] Error: ${e.message}`);
    return fs.existsSync(out) ? out : null;
  }
}

function parse(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf-8"));
    const a = d.aggregate || {}, c = a.counters || {}, s = a.summaries || {};
    const rt = s["http.response_time"] || {}, pk = s["payload_size_kb"] || {};
    const codes = {};
    Object.keys(c).forEach(k => { const m = k.match(/^http\.codes\.(\d+)$/); if (m) codes[m[1]] = c[k]; });
    return {
      req: c["http.requests"] || 0,
      ok: (codes["200"]||0) + (codes["304"]||0),
      err5: (codes["500"]||0)+(codes["502"]||0)+(codes["503"]||0),
      vu: c["vusers.created"] || 0,
      rt: { min:rt.min||0, med:rt.median||0, p95:rt.p95||0, p99:rt.p99||0, max:rt.max||0 },
      pk: { med: pk.median||0 },
      codes,
    };
  } catch { return null; }
}

// ── Report ──────────────────────────────────────────────────────
function report(results) {
  const rows = results.filter(r => r.p);

  console.log("\n   ┌────────┬───────┬─────────┬────────┬────────┬────────┬────────┬─────────┐");
  console.log("   │  # POI │ VU/s  │ Requests│ Median │  p95   │  p99   │  Max   │ Success │");
  console.log("   ├────────┼───────┼─────────┼────────┼────────┼────────┼────────┼─────────┤");
  for (const r of rows) {
    const rate = r.p.req > 0 ? ((r.p.ok / r.p.req) * 100).toFixed(1) : "0.0";
    console.log(`   │${String(r.poi).padStart(7)} │${String(r.vu).padStart(6)} │${String(r.p.req).padStart(8)} │${String(r.p.rt.med.toFixed(0)).padStart(7)} │${String(r.p.rt.p95.toFixed(0)).padStart(7)} │${String(r.p.rt.p99.toFixed(0)).padStart(7)} │${String(r.p.rt.max.toFixed(0)).padStart(7)} │${(rate+"%").padStart(8)} │`);
  }
  console.log("   └────────┴───────┴─────────┴────────┴────────┴────────┴────────┴─────────┘\n");

  const hr = rows.map(r => {
    const rate = r.p.req > 0 ? ((r.p.ok / r.p.req)*100).toFixed(1) : "0.0";
    const mb = (r.p.pk.med/1024).toFixed(2);
    return { poi:r.poi, mb, vu:r.vu, req:r.p.req, med:r.p.rt.med.toFixed(0), p95:r.p.rt.p95.toFixed(0), p99:r.p.rt.p99.toFixed(0), max:r.p.rt.max.toFixed(0), rate, p95c:r.p.rt.p95>3000?"#c62828":"#2e7d32", rc:parseFloat(rate)>=95?"#2e7d32":parseFloat(rate)>=80?"#e65100":"#c62828" };
  });

  const html=`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>DiDe Citizen Load Test</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"><\/script>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;color:#333}.hdr{background:linear-gradient(135deg,#1565c0,#0d47a1);color:#fff;padding:32px;text-align:center}.hdr h1{font-size:22px;margin-bottom:6px}.hdr p{opacity:.8;font-size:13px}.w{max-width:1200px;margin:0 auto;padding:20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:18px 0}.cd{background:#fff;border-radius:10px;padding:18px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.07)}.cd .v{font-size:26px;font-weight:700;color:#1565c0;margin:6px 0}.cd .l{font-size:11px;color:#888;text-transform:uppercase}.s{background:#fff;border-radius:10px;padding:22px;margin:18px 0;box-shadow:0 2px 6px rgba(0,0,0,.07)}.s h2{font-size:16px;color:#1565c0;margin-bottom:14px;padding-bottom:6px;border-bottom:2px solid #e3f2fd}table{width:100%;border-collapse:collapse;font-size:13px}th{background:#e3f2fd;padding:10px 12px;text-align:center;font-weight:600;border-bottom:2px solid #bbdefb}td{padding:9px 12px;border-bottom:1px solid #f0f0f0;text-align:center}tr:hover{background:#fafafa}.b{display:inline-block;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;color:#fff}.ch{position:relative;height:340px;margin:14px 0}.cfg{background:#e3f2fd;border-radius:8px;padding:14px;margin:14px 0;font-size:12px;line-height:1.8}.cfg b{color:#0d47a1}.ft{text-align:center;padding:18px;color:#aaa;font-size:11px}</style></head><body>
<div class="hdr"><h1>DiDe — Citizen Load Test Report</h1><p>Unauthenticated User Read Performance | ${new Date().toISOString().slice(0,19).replace("T"," ")}</p></div>
<div class="w">
<div class="cfg"><b>Target:</b> ${TARGET_URL} | <b>Sustained:</b> ${TEST_DUR}s | <b>Ramp:</b> ${RAMP_DUR}s | <b>POI:</b> ${hr[0]?.poi||'-'} | <b>VU/s:</b> ${hr.map(r=>r.vu).join(", ")}</div>
<div class="cards"><div class="cd"><div class="l">Experiments</div><div class="v">${hr.length}</div></div><div class="cd"><div class="l">Public POI</div><div class="v">${hr[0]?.poi||'-'}</div></div><div class="cd"><div class="l">Max VU/s</div><div class="v">${hr[hr.length-1]?.vu||'-'}</div></div><div class="cd"><div class="l">POI Size</div><div class="v">${hr[0]?.mb||'-'} MB</div></div></div>
<div class="s"><h2>Citizen Performance Table</h2><table><thead><tr><th># Public<br>POI</th><th>POI Size<br>(MB)</th><th>Concurrent<br>Users [VU/s]</th><th>Total<br>Requests</th><th>Median<br>(ms)</th><th>p95<br>(ms)</th><th>p99<br>(ms)</th><th>Max<br>(ms)</th><th>Success<br>Rate</th></tr></thead><tbody>${hr.map(r=>`<tr><td><b>${Number(r.poi).toLocaleString()}</b></td><td>${r.mb}</td><td><b>${r.vu}</b></td><td>${Number(r.req).toLocaleString()}</td><td>${r.med}</td><td style="color:${r.p95c};font-weight:600">${r.p95}</td><td>${r.p99}</td><td>${r.max}</td><td><span class="b" style="background:${r.rc}">${r.rate}%</span></td></tr>`).join("")}</tbody></table></div>
<div class="s"><h2>Response Time vs VU/s</h2><div class="ch"><canvas id="c1"></canvas></div></div>
<div class="s"><h2>Success Rate vs VU/s</h2><div class="ch"><canvas id="c2"></canvas></div></div>
</div><div class="ft">DiDe Citizen Load Test | ${new Date().toISOString().slice(0,10)}</div>
<script>const D=${JSON.stringify(hr)};const L=D.map(d=>d.vu+' VU/s');
new Chart(document.getElementById('c1'),{type:'line',data:{labels:L,datasets:[{label:'Median (ms)',data:D.map(d=>+d.med),borderColor:'#1565c0',backgroundColor:'rgba(21,101,192,.1)',fill:true,tension:.3},{label:'p95 (ms)',data:D.map(d=>+d.p95),borderColor:'#ff9800',borderDash:[5,5],tension:.3},{label:'p99 (ms)',data:D.map(d=>+d.p99),borderColor:'#f44336',borderDash:[2,2],tension:.3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top'}},scales:{y:{title:{display:true,text:'ms'},beginAtZero:true}}}});
new Chart(document.getElementById('c2'),{type:'bar',data:{labels:L,datasets:[{label:'Success Rate (%)',data:D.map(d=>+d.rate),backgroundColor:D.map(d=>d.rc),borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,scales:{y:{title:{display:true,text:'%'},beginAtZero:true,max:100}}}});
<\/script></body></html>`;

  fs.writeFileSync(REPORT, html, "utf-8");
  console.log(`   [REPORT] ${REPORT}`);
  try { execSync(`${process.platform==="win32"?"start":process.platform==="darwin"?"open":"xdg-open"} "${REPORT}"`, { stdio:"ignore" }); } catch {}
}

// ── MAIN ────────────────────────────────────────────────────────
async function main() {
  console.log("══════════════════════════════════════════════════════");
  console.log("   DiDe — Citizen Read Load Test (HTTP only)");
  console.log("══════════════════════════════════════════════════════");
  console.log(`   Target     : ${TARGET_URL}`);
  console.log(`   Sustained  : ${TEST_DUR}s  |  Ramp: ${RAMP_DUR}s`);
  console.log(`   VU/s steps : ${VU_STEPS.join(", ")}`);
  console.log(`   Output     : ${OUTPUTS}`);

  const poi = await getPublicPOI();
  console.log(`   Public POI : ${poi}`);
  console.log("══════════════════════════════════════════════════════");

  if (!fs.existsSync(YML_BASE)) { console.error(`   ERROR: ${YML_BASE} not found`); process.exit(1); }
  fs.mkdirSync(OUTPUTS, { recursive: true });

  const all = [];
  for (let i = 0; i < VU_STEPS.length; i++) {
    const vu = VU_STEPS[i];
    const curPoi = await getPublicPOI();
    console.log(`\n${"═".repeat(54)}`);
    console.log(`   EXP ${i+1}/${VU_STEPS.length}: ${curPoi} POI @ ${vu} VU/s`);
    console.log("═".repeat(54));

    const f = runArtillery(i+1, vu);
    const p = parse(f);
    all.push({ poi: curPoi, vu, p });
    console.log(`   [INFO] Experiment ${i+1} done ✓`);

    if (i < VU_STEPS.length - 1) { console.log("   [WAIT] 5s..."); await new Promise(r=>setTimeout(r,5000)); }
  }

  console.log(`\n${"═".repeat(54)}`);
  console.log("   GENERATING REPORT");
  console.log("═".repeat(54));
  report(all);
  if (fs.existsSync(YML_RUN)) fs.unlinkSync(YML_RUN);
  console.log(`\n${"═".repeat(54)}`);
  console.log("   ALL EXPERIMENTS COMPLETE ✓");
  console.log(`${"═".repeat(54)}\n`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });