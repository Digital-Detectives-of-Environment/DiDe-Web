#!/usr/bin/env node
"use strict";

const path         = require("path");
const fs           = require("fs");
const { execSync } = require("child_process");

require("dotenv").config({ path: path.resolve(__dirname, ".env") });

let bcrypt, Pool;
try {
  bcrypt = require("bcrypt");
  Pool   = require("pg").Pool;
} catch (err) {
  console.error("ERROR: 'bcrypt' or 'pg' module not found. Run npm install."); process.exit(1);
}

const PREFIX = "artillery_test_", AUTO_PASSWORD = "ArtLoad_2026!x";
const SV_COUNT = parseInt(process.env.ARTILLERY_SUPERVISOR_COUNT||"3",10);
const UZ_COUNT = parseInt(process.env.ARTILLERY_UZMAN_COUNT||"5",10);
const TARGET_URL = process.env.TARGET_URL||"http://localhost:3000";
const VU_PER_SEC = parseInt(process.env.TOTAL_VU_PER_SEC||"10",10);
const TEST_DUR = parseInt(process.env.TEST_DURATION_SEC||"60",10);
const RAMP_DUR = parseInt(process.env.RAMP_DURATION_SEC||"30",10);

const CSV_SV = path.join(__dirname,"test-users-supervisor.csv");
const CSV_UZ = path.join(__dirname,"test-users-uzman.csv");
const RESULTS = path.join(__dirname,"artillery-results.json");
const REPORT = path.join(__dirname,"artillery-report.html");
const YML_BASE = path.join(__dirname,"load-test.yml");
const YML_RUN = path.join(__dirname,".artillery-run.yml");

const args = process.argv.slice(2);
const FLAG_KEEP = args.includes("--keep-users");
const FLAG_CLEANUP = args.includes("--cleanup-only");

const pool = new Pool({
  host: process.env.PGHOST||"localhost",
  port: parseInt(process.env.PGPORT||"5432",10),
  database: process.env.PGDATABASE||"dide",
  user: process.env.PGUSER||"postgres",
  password: process.env.PGPASSWORD||"",
});

function buildRunYaml(){
  const base = fs.readFileSync(YML_BASE,"utf-8");
  const m = base.match(/^scenarios:/m);
  if(!m) throw new Error("'scenarios:' not found in load-test.yml!");
  const scenarios = base.substring(m.index);
  const config = `config:
  target: "${TARGET_URL}"
  phases:
    - name: "Warm Up"
      duration: ${RAMP_DUR}
      arrivalRate: 1
      rampTo: ${VU_PER_SEC}
    - name: "Sustained Load"
      duration: ${TEST_DUR}
      arrivalRate: ${VU_PER_SEC}
    - name: "Cool Down"
      duration: 10
      arrivalRate: ${VU_PER_SEC}
      rampTo: 1
  payload:
    - path: "./test-users-supervisor.csv"
      fields: ["sv_username","sv_password"]
      order: random
      skipHeader: true
    - path: "./test-users-uzman.csv"
      fields: ["uz_username","uz_password"]
      order: random
      skipHeader: true
  defaults:
    headers:
      Content-Type: "application/json"
      Accept: "application/json"
  plugins:
    metrics-by-endpoint: {}
    ensure: {}
  ensure:
    thresholds:
      - http.response_time.p95: 3000
      - http.response_time.p99: 5000
    conditions:
      - expression: "http.codes.500 < 20"
        strict: true
  processor: "./processor.js"

`;
  fs.writeFileSync(YML_RUN, config + scenarios, "utf-8");
}

async function createTestUsers(){
  console.log("\n[1/4] Creating test users...");
  const client = await pool.connect();
  const created = {supervisor:[],user:[]};
  try{
    const hash = await bcrypt.hash(AUTO_PASSWORD,10);
    for(const [role,count] of [["supervisor",SV_COUNT],["user",UZ_COUNT]]){
      for(let i=1;i<=count;i++){
        const u=`${PREFIX}${role}_${i}`, e=`${u}@artillery-test.local`;
        const ex = await client.query("SELECT id FROM users WHERE username=$1",[u]);
        if(ex.rows.length>0){created[role].push(u);continue;}
        await client.query("BEGIN");
        try{
          await client.query(`SELECT set_config('app.password_plain',$1,true)`,[AUTO_PASSWORD]);
          await client.query(`INSERT INTO users(username,password_hash,role,name,surname,email,email_verified,is_verified,is_active,two_factor_enabled,two_factor_secret)VALUES($1,$2,$3,$4,$5,$6,TRUE,TRUE,TRUE,FALSE,NULL)`,[u,hash,role,`Test_${role}`,`${i}`,e]);
          await client.query("COMMIT");
          created[role].push(u); console.log(`      + ${u}`);
        }catch(err){
          try{await client.query("ROLLBACK")}catch{}
          if(err.code==="23505"||err.code==="P0002") created[role].push(u);
          else console.error(`      x ${u}: ${err.message}`);
        }finally{try{await client.query(`SELECT set_config('app.password_plain',NULL,true)`)}catch{}}
      }
    }
    for(const [role,file] of [["supervisor",CSV_SV],["user",CSV_UZ]]){
      let csv="username,password\n";
      created[role].forEach(u=>{csv+=`${u},${AUTO_PASSWORD}\n`});
      fs.writeFileSync(file,csv,"utf-8");
    }
    console.log(`      Supervisors: ${created.supervisor.length} | Experts: ${created.user.length}`);
  }finally{client.release()}
}

async function cleanup(){
  console.log("\n[4/4] Cleaning up...");
  const client = await pool.connect();
  try{
    await client.query("BEGIN");
    const o = await client.query(`DELETE FROM olay WHERE created_by_name LIKE $1`,[PREFIX+"%"]);
    const u = await client.query(`DELETE FROM users WHERE username LIKE $1`,[PREFIX+"%"]);
    await client.query("COMMIT");
    console.log(`      ${o.rowCount} test events + ${u.rowCount} test users deleted`);
  }catch(err){try{await client.query("ROLLBACK")}catch{};console.error(`      ${err.message}`)}
  finally{client.release()}
  for(const f of [CSV_SV,CSV_UZ,YML_RUN]) if(fs.existsSync(f)) fs.unlinkSync(f);
  console.log("      Temporary files removed. Cleanup complete.\n");
}

function runArtillery(){
  console.log("\n[2/4] Starting Artillery test...");
  console.log(`      Target: ${TARGET_URL} | VU/s: ${VU_PER_SEC} | Duration: ${TEST_DUR}s | Ramp: ${RAMP_DUR}s\n`);
  buildRunYaml();
  try{execSync(`artillery run "${YML_RUN}" --output "${RESULTS}"`,{stdio:"inherit",env:process.env});return true}
  catch{return false}
}

// ── HTML REPORT GENERATOR ────────────────────────────────────────────────

function generateReport(){
  if(!fs.existsSync(RESULTS)){console.log("\n[3/4] No JSON results file found, skipping report.");return}
  console.log("\n[3/4] Generating HTML report...");

  const data = JSON.parse(fs.readFileSync(RESULTS,"utf-8"));
  const agg = data.aggregate;
  const c = agg.counters||{};
  const s = agg.summaries||{};
  const periods = data.intermediate||[];

  const endpoints = [];
  Object.keys(s).forEach(k=>{
    const m = k.match(/^plugins\.metrics-by-endpoint\.response_time\.(.+)$/);
    if(m) endpoints.push({name:m[1], ...s[k]});
  });
  endpoints.sort((a,b)=>b.count-a.count);

  const codes = {};
  Object.keys(c).forEach(k=>{ const m=k.match(/^http\.codes\.(\d+)$/); if(m) codes[m[1]]=c[k]; });

  const errors = {};
  Object.keys(c).forEach(k=>{ const m=k.match(/^errors\.(.+)$/); if(m) errors[m[1]]=c[k]; });

  const scenarios = {};
  Object.keys(c).forEach(k=>{ const m=k.match(/^vusers\.created_by_name\.(.+)$/); if(m) scenarios[m[1]]=c[k]; });

  const timeline = periods.map((p,i)=>{
    const pc=p.counters||{}, ps=p.summaries||{}, rt=ps["http.response_time"]||{};
    return {
      period:i+1, rps:pc["http.requests"]||0, ok:pc["http.codes.200"]||0,
      err4:Object.keys(pc).filter(k=>k.match(/^http\.codes\.4/)).reduce((s,k)=>s+pc[k],0),
      err5:Object.keys(pc).filter(k=>k.match(/^http\.codes\.5/)).reduce((s,k)=>s+pc[k],0),
      timeout:pc["errors.ETIMEDOUT"]||0, p50:rt.median||0, p95:rt.p95||0, p99:rt.p99||0,
    };
  });

  const rt = s["http.response_time"]||{};
  const totalReq=c["http.requests"]||0, totalResp=c["http.responses"]||0;
  const totalCompleted=c["vusers.completed"]||0, totalCreated=c["vusers.created"]||0;
  // Artillery ensure plugin maxErrorRate formulunu kullaniyoruz:
  // errorRate = ((vusers.created - vusers.completed) / vusers.created) * 100
  // successRate = 100 - errorRate
  const errorRate = totalCreated>0?(((totalCreated-totalCompleted)/totalCreated)*100):100;
  const successRate = (100 - errorRate).toFixed(1);

  const codeColors={"200":"#4caf50","201":"#66bb6a","301":"#2196f3","400":"#ff9800","401":"#f57c00","403":"#e65100","404":"#ff5722","500":"#f44336","502":"#d32f2f","503":"#b71c1c"};

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DiDe - Artillery Load Test Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;color:#333}
.header{background:linear-gradient(135deg,#1565c0,#0d47a1);color:#fff;padding:32px;text-align:center}
.header h1{font-size:24px;margin-bottom:8px}.header p{opacity:.8;font-size:14px}
.container{max-width:1200px;margin:0 auto;padding:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin:20px 0}
.card{background:#fff;border-radius:12px;padding:20px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.card .value{font-size:28px;font-weight:700;margin:8px 0}.card .label{font-size:12px;color:#666;text-transform:uppercase}
.card.green .value{color:#2e7d32}.card.red .value{color:#c62828}.card.orange .value{color:#e65100}.card.blue .value{color:#1565c0}
.section{background:#fff;border-radius:12px;padding:24px;margin:20px 0;box-shadow:0 2px 8px rgba(0,0,0,.08)}
.section h2{font-size:18px;color:#1565c0;margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid #e3f2fd}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f5f5f5;padding:10px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e0e0e0}
td{padding:8px 12px;border-bottom:1px solid #f0f0f0}tr:hover{background:#fafafa}
.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;color:#fff}
.chart-container{position:relative;height:300px;margin:16px 0}
.bar{display:inline-block;height:20px;border-radius:3px;margin:2px 0}
.footer{text-align:center;padding:20px;color:#999;font-size:12px}
</style>
</head>
<body>
<div class="header">
  <h1>DiDe - Artillery Load Test Report</h1>
  <p>${TARGET_URL} | ${VU_PER_SEC} VU/s | ${TEST_DUR}s duration | ${new Date().toISOString().slice(0,19).replace("T"," ")}</p>
</div>
<div class="container">

<div class="cards">
  <div class="card blue"><div class="label">Total Requests</div><div class="value">${totalReq.toLocaleString()}</div></div>
  <div class="card green"><div class="label">Successful (200)</div><div class="value">${(codes["200"]||0).toLocaleString()}</div></div>
  <div class="card red"><div class="label">Server Errors (5xx)</div><div class="value">${(codes["500"]||0)+(codes["502"]||0)+(codes["503"]||0)}</div></div>
  <div class="card orange"><div class="label">Timeouts</div><div class="value">${(errors["ETIMEDOUT"]||0).toLocaleString()}</div></div>
  <div class="card blue"><div class="label">VUs Created</div><div class="value">${totalCreated.toLocaleString()}</div></div>
  <div class="card ${parseFloat(successRate)>50?"green":"red"}"><div class="label">Success Rate</div><div class="value">${successRate}%</div></div>
</div>

<div class="section">
  <h2>Response Time (ms)</h2>
  <div class="cards" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
    <div class="card"><div class="label">Min</div><div class="value" style="font-size:20px">${rt.min||0}</div></div>
    <div class="card"><div class="label">Median</div><div class="value" style="font-size:20px">${(rt.median||0).toFixed(0)}</div></div>
    <div class="card"><div class="label">Mean</div><div class="value" style="font-size:20px">${(rt.mean||0).toFixed(0)}</div></div>
    <div class="card orange"><div class="label">p95</div><div class="value" style="font-size:20px">${(rt.p95||0).toFixed(0)}</div></div>
    <div class="card red"><div class="label">p99</div><div class="value" style="font-size:20px">${(rt.p99||0).toFixed(0)}</div></div>
    <div class="card red"><div class="label">Max</div><div class="value" style="font-size:20px">${rt.max||0}</div></div>
  </div>
</div>

<div class="section">
  <h2>Response Time Over Time</h2>
  <div class="chart-container"><canvas id="timelineChart"></canvas></div>
</div>

<div class="section">
  <h2>Request & Error Counts Over Time</h2>
  <div class="chart-container"><canvas id="rpsChart"></canvas></div>
</div>

<div class="section">
  <h2>HTTP Status Codes</h2>
  <table>
    <tr><th>Code</th><th>Count</th><th>Ratio</th><th>Visual</th></tr>
    ${Object.entries(codes).sort((a,b)=>b[1]-a[1]).map(([code,cnt])=>{
      const pct=totalResp>0?(cnt/totalResp*100).toFixed(1):"0";
      const color=codeColors[code]||"#999";
      return `<tr><td><span class="badge" style="background:${color}">${code}</span></td><td>${cnt.toLocaleString()}</td><td>${pct}%</td><td><div class="bar" style="width:${Math.max(pct*3,4)}px;background:${color}"></div></td></tr>`;
    }).join("")}
  </table>
</div>

<div class="section">
  <h2>Errors</h2>
  <table>
    <tr><th>Error Type</th><th>Count</th><th>Description</th></tr>
    ${Object.entries(errors).map(([name,cnt])=>{
      const desc={"ETIMEDOUT":"Server did not respond (timeout)","ECONNREFUSED":"Server refused connection","ECONNRESET":"Connection reset by server","Failed capture or match":"Response did not match expected format"}[name]||"";
      return `<tr><td><b>${name}</b></td><td>${cnt.toLocaleString()}</td><td>${desc}</td></tr>`;
    }).join("")}
  </table>
</div>

<div class="section">
  <h2>Endpoint Performance</h2>
  <table>
    <tr><th>Endpoint</th><th>Requests</th><th>Min</th><th>Median</th><th>p95</th><th>p99</th><th>Max</th></tr>
    ${endpoints.map(e=>`<tr><td><b>${e.name}</b></td><td>${e.count}</td><td>${e.min}</td><td>${(e.median||0).toFixed(0)}</td><td style="color:${e.p95>3000?"#c62828":"#333"}">${(e.p95||0).toFixed(0)}</td><td style="color:${e.p99>5000?"#c62828":"#333"}">${(e.p99||0).toFixed(0)}</td><td>${e.max}</td></tr>`).join("")}
  </table>
</div>

<div class="section">
  <h2>Scenario Distribution</h2>
  <table>
    <tr><th>Scenario</th><th>VU Count</th><th>Ratio</th></tr>
    ${Object.entries(scenarios).sort((a,b)=>b[1]-a[1]).map(([name,cnt])=>{
      const pct=totalCreated>0?(cnt/totalCreated*100).toFixed(1):"0";
      return `<tr><td>${name}</td><td>${cnt.toLocaleString()}</td><td>${pct}%</td></tr>`;
    }).join("")}
  </table>
</div>

</div>
<div class="footer">DiDe Artillery Load Test Report | ${new Date().toISOString().slice(0,19).replace("T"," ")}</div>

<script>
const tl=${JSON.stringify(timeline)};
new Chart(document.getElementById("timelineChart"),{
  type:"line",
  data:{labels:tl.map(t=>"P"+t.period),datasets:[
    {label:"Median (ms)",data:tl.map(t=>t.p50),borderColor:"#1565c0",backgroundColor:"rgba(21,101,192,.1)",fill:true,tension:.3},
    {label:"p95 (ms)",data:tl.map(t=>t.p95),borderColor:"#ff9800",borderDash:[5,5],tension:.3},
    {label:"p99 (ms)",data:tl.map(t=>t.p99),borderColor:"#f44336",borderDash:[2,2],tension:.3}
  ]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"top"}},scales:{y:{title:{display:true,text:"ms"}}}}
});
new Chart(document.getElementById("rpsChart"),{
  type:"bar",
  data:{labels:tl.map(t=>"P"+t.period),datasets:[
    {label:"200 OK",data:tl.map(t=>t.ok),backgroundColor:"#4caf50"},
    {label:"4xx",data:tl.map(t=>t.err4),backgroundColor:"#ff9800"},
    {label:"5xx",data:tl.map(t=>t.err5),backgroundColor:"#f44336"},
    {label:"Timeout",data:tl.map(t=>t.timeout),backgroundColor:"#9e9e9e"}
  ]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"top"}},scales:{x:{stacked:true},y:{stacked:true,title:{display:true,text:"Count"}}}}
});
<\/script>
</body></html>`;

  fs.writeFileSync(REPORT, html, "utf-8");
  console.log(`      Report generated: ${REPORT}`);
  try{
    const opener=process.platform==="win32"?"start":process.platform==="darwin"?"open":"xdg-open";
    execSync(`${opener} "${REPORT}"`,{stdio:"ignore"});
  }catch{}
}

// ── MAIN ─────────────────────────────────────────────────────────────────

async function main(){
  console.log("==========================================================");
  console.log("    DiDe - Artillery Load Test Orchestrator");
  console.log("==========================================================");

  try{await pool.query("SELECT 1");console.log(`  DB: ${process.env.PGHOST||"localhost"}:${process.env.PGPORT||"5432"}/${process.env.PGDATABASE||"dide"}`)}
  catch(err){console.error(`  DB connection error: ${err.message}`);process.exit(1)}

  if(FLAG_CLEANUP){await cleanup();await pool.end();return}
  if(!fs.existsSync(YML_BASE)){console.error(`  ERROR: ${YML_BASE} not found!`);process.exit(1)}

  try{
    await createTestUsers();
    runArtillery();
    generateReport();
  }finally{
    if(!FLAG_KEEP) await cleanup();
    else console.log("\n  --keep-users is active, skipping cleanup.");
  }
  await pool.end();
}

let cleaning=false;
async function emergencyCleanup(){
  if(cleaning)return;cleaning=true;
  console.log("\n\n  Interrupted, cleaning up...");
  if(!FLAG_KEEP){try{await cleanup()}catch{}}
  try{await pool.end()}catch{};process.exit(0);
}
process.on("SIGINT",emergencyCleanup);
process.on("SIGTERM",emergencyCleanup);

main().catch(async err=>{
  console.error("\nError:",err.message);
  if(!FLAG_KEEP){try{await cleanup()}catch{}}
  try{await pool.end()}catch{};process.exit(1);
});