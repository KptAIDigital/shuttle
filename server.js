const express=require("express"),path=require("path"),crypto=require("crypto"),{Pool}=require("pg"),ExcelJS=require("exceljs");
const seed=require("./data/employees.json");
const PORT=process.env.PORT||3000,SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");
const dbUrl=process.env.DATABASE_URL;
const pool=new Pool({connectionString:dbUrl,ssl:dbUrl&&/\./.test(new URL(dbUrl).hostname)&&process.env.DB_SSL!=="false"?{rejectUnauthorized:false}:false});
const Q=(t,p)=>pool.query(t,p), TODAY="((now() AT TIME ZONE 'Asia/Bangkok')::date)";
const A=f=>(q,s,n)=>f(q,s,n).catch(n);

async function initDb(){
  await Q(`
  CREATE TABLE IF NOT EXISTS employees(staff_no TEXT PRIMARY KEY,name TEXT NOT NULL,org TEXT NOT NULL,post TEXT,active BOOLEAN NOT NULL DEFAULT true);
  CREATE TABLE IF NOT EXISTS pickups(id SERIAL PRIMARY KEY,sort INT NOT NULL DEFAULT 0,name TEXT NOT NULL,time TEXT NOT NULL DEFAULT '',free_text BOOLEAN NOT NULL DEFAULT false,active BOOLEAN NOT NULL DEFAULT true);
  CREATE TABLE IF NOT EXISTS registrations(id SERIAL PRIMARY KEY,staff_no TEXT NOT NULL,emp_name TEXT NOT NULL,org TEXT NOT NULL,pickup TEXT NOT NULL,pickup_other TEXT,phone TEXT,note TEXT,
    service_date DATE NOT NULL DEFAULT ${TODAY},created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(staff_no,service_date));
  CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'HR',active BOOLEAN NOT NULL DEFAULT true);`);
  if(!(await Q("SELECT 1 FROM employees LIMIT 1")).rowCount){
    const ids=Object.keys(seed);
    await Q(`INSERT INTO employees(staff_no,name,org) SELECT * FROM unnest($1::text[],$2::text[],$3::text[]) ON CONFLICT DO NOTHING`,[ids,ids.map(i=>seed[i].n),ids.map(i=>seed[i].o)]);
  }
  if(!(await Q("SELECT 1 FROM pickups LIMIT 1")).rowCount)
    await Q(`INSERT INTO pickups(sort,name,time,free_text) VALUES (1,'BIG C ราชบุรี','07:00 น.',false),(2,'7-11 ทางเข้าวัดหนองหนอย','07:00 น.',false),(3,'เทศบาลตำบลเขางู','07:00 น.',false),(4,'อื่น ๆ (โปรดระบุ)','',true)`);
  const {ADMIN_EMAIL:e,ADMIN_PASSWORD:p}=process.env;
  if(e&&p&&!(await Q("SELECT 1 FROM users LIMIT 1")).rowCount)
    await Q("INSERT INTO users(name,email,password_hash,role) VALUES('Admin',$1,$2,'Admin')",[e.toLowerCase(),hash(p)]);
}

/* ---------- auth ---------- */
const hash=(pw,s=crypto.randomBytes(16).toString("hex"))=>s+":"+crypto.scryptSync(pw,s,32).toString("hex");
const verify=(pw,h)=>{const[s,x]=h.split(":"),y=crypto.scryptSync(pw,s,32).toString("hex");return crypto.timingSafeEqual(Buffer.from(x),Buffer.from(y))};
const sign=v=>crypto.createHmac("sha256",SECRET).update(v).digest("base64url");
function me(req){const c=(req.headers.cookie||"").split(/;\s*/).find(x=>x.startsWith("sid="));if(!c)return null;const[v,g]=c.slice(4).split(".");if(!g||sign(v)!==g)return null;try{const p=JSON.parse(Buffer.from(v,"base64url").toString());return p.exp>Date.now()?p:null}catch{return null}}
const need=(...roles)=>async(q,s,n)=>{try{const u=me(q);if(!u)return s.status(401).json({error:"unauthorized"});
  const d=(await Q("SELECT id,name,role FROM users WHERE id=$1 AND active",[u.id])).rows[0];if(!d)return s.status(401).json({error:"unauthorized"});
  if(roles.length&&!roles.includes(d.role))return s.status(403).json({error:"forbidden"});q.user=d;n()}catch(e){n(e)}};
const hits=new Map();
const limiter=(max,ms)=>(q,s,n)=>{const now=Date.now(),k=(q.headers["cf-connecting-ip"]||q.ip)+q.path,r=(hits.get(k)||[]).filter(t=>now-t<ms);if(r.length>=max)return s.status(429).json({error:"too_many_requests"});r.push(now);hits.set(k,r);n()};
setInterval(()=>hits.clear(),600000).unref();

const app=express();app.set("trust proxy",true);app.use(express.json({limit:"20kb"}));
app.get("/healthz",(_,r)=>r.send("ok"));

/* ---------- public ---------- */
app.get("/api/pickups",A(async(_,r)=>r.json((await Q("SELECT id,name,time,free_text FROM pickups WHERE active ORDER BY sort,id")).rows)));
app.get("/api/lookup",limiter(40,60000),A(async(q,r)=>{
  const id=String(q.query.id||"").trim();if(!/^\d{1,10}$/.test(id))return r.status(400).json({found:false});
  const x=(await Q(`SELECT e.name,e.org,(SELECT count(*) FROM registrations g WHERE g.staff_no=e.staff_no AND g.service_date=${TODAY})>0 already FROM employees e WHERE staff_no=$1 AND active`,[id])).rows[0];
  if(!x)return r.status(404).json({found:false});r.json({found:true,name:x.name,org:x.org,already:x.already});
}));
app.post("/api/submit",limiter(10,60000),A(async(q,r)=>{
  const b=q.body||{},id=String(b.emp_id||"").trim(),other=String(b.pickup_other||"").trim().slice(0,200),note=String(b.note||"").trim().slice(0,500),phone=String(b.phone||"").replace(/\D/g,"");
  const pk=(await Q("SELECT * FROM pickups WHERE id=$1 AND active",[parseInt(b.pickup_id)||0])).rows[0];
  if(!/^\d{1,10}$/.test(id)||!pk||(pk.free_text&&!other)||(phone&&!/^0\d{8,9}$/.test(phone)))return r.status(400).json({error:"invalid"});
  const e=(await Q("SELECT name,org FROM employees WHERE staff_no=$1 AND active",[id])).rows[0];if(!e)return r.status(404).json({error:"employee_not_found"});
  const d=(await Q(`INSERT INTO registrations(staff_no,emp_name,org,pickup,pickup_other,phone,note) VALUES($1,$2,$3,$4,$5,$6,$7)
   ON CONFLICT(staff_no,service_date) DO UPDATE SET pickup=EXCLUDED.pickup,pickup_other=EXCLUDED.pickup_other,phone=EXCLUDED.phone,note=EXCLUDED.note,updated_at=now()
   RETURNING to_char(service_date,'YYYY-MM-DD') d`,[id,e.name,e.org,pk.name,pk.free_text?other:null,phone||null,note||null])).rows[0].d;
  r.json({ok:true,name:e.name,date:d});
}));

/* ---------- admin ---------- */
app.get(["/admin","/admin/"],(_,r)=>r.sendFile(path.join(__dirname,"private","admin.html")));
app.post("/admin/api/login",limiter(8,60000),A(async(q,r)=>{
  const u=(await Q("SELECT * FROM users WHERE email=$1 AND active",[String(q.body.email||"").trim().toLowerCase()])).rows[0];
  if(!u||!verify(String(q.body.password||""),u.password_hash))return r.status(401).json({error:"อีเมลหรือรหัสผ่านไม่ถูกต้อง"});
  const v=Buffer.from(JSON.stringify({id:u.id,name:u.name,role:u.role,exp:Date.now()+12*3600e3})).toString("base64url");
  r.setHeader("Set-Cookie",`sid=${v}.${sign(v)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);r.json({name:u.name,role:u.role});
}));
app.post("/admin/api/logout",(_,r)=>{r.setHeader("Set-Cookie","sid=; HttpOnly; Secure; Path=/; Max-Age=0");r.json({ok:true})});
app.get("/admin/api/me",need(),(q,r)=>r.json({name:q.user.name,role:q.user.role}));

const D=/^\d{4}-\d{2}-\d{2}$/;
const regs=(f,t)=>Q(`SELECT id,staff_no,emp_name,org,pickup,pickup_other,phone,note,to_char(service_date,'YYYY-MM-DD') d,updated_at FROM registrations WHERE service_date BETWEEN $1 AND $2 ORDER BY service_date,pickup,org,staff_no`,[f,t]);
app.get("/admin/api/regs",need(),A(async(q,r)=>{const{from:f,to:t}=q.query;if(!D.test(f)||!D.test(t))return r.status(400).json({error:"bad_range"});
  r.json({rows:(await regs(f,t)).rows,employees:(await Q("SELECT count(*)::int n FROM employees WHERE active")).rows[0].n})}));
app.get("/admin/export.xlsx",need(),A(async(q,r)=>{const{from:f,to:t,pickup:p}=q.query;if(!D.test(f)||!D.test(t))return r.status(400).end();
  let rows=(await regs(f,t)).rows;if(p)rows=rows.filter(x=>x.pickup===p);
  const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet("รายชื่อ");
  ws.columns=[["วันที่","d",12],["จุดรับ-ส่ง","pickup",30],["รหัส","staff_no",9],["ชื่อ-นามสกุล","emp_name",28],["หน่วยงาน","org",28],["โทร","phone",13],["หมายเหตุ","note",30]].map(([header,key,width])=>({header,key,width}));
  rows.forEach(x=>ws.addRow({...x,pickup:x.pickup_other?`${x.pickup}: ${x.pickup_other}`:x.pickup}));
  ws.getRow(1).font={bold:true,color:{argb:"FFFFFFFF"}};ws.getRow(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFE8141C"}};ws.views=[{state:"frozen",ySplit:1}];
  r.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");r.setHeader("Content-Disposition",`attachment; filename="shuttle_${f}_${t}.xlsx"`);
  await wb.xlsx.write(r);r.end();}));

const admin=need("Admin"),staff=need("Admin");
app.get("/admin/api/pickups",staff,A(async(_,r)=>r.json((await Q("SELECT p.*,(SELECT count(*)::int FROM registrations g WHERE g.pickup=p.name) used FROM pickups p ORDER BY sort,id")).rows)));
app.post("/admin/api/pickups",staff,A(async(q,r)=>{const b=q.body,n=String(b.name||"").trim();if(!n)return r.status(400).json({error:"กรุณาระบุชื่อจุด"});
  await Q("INSERT INTO pickups(sort,name,time,free_text) VALUES($1,$2,$3,$4)",[parseInt(b.sort)||99,n,String(b.time||"").trim(),!!b.free_text]);r.json({ok:true})}));
app.put("/admin/api/pickups/:id",staff,A(async(q,r)=>{const b=q.body,n=String(b.name||"").trim();if(!n)return r.status(400).json({error:"กรุณาระบุชื่อจุด"});
  await Q("UPDATE pickups SET sort=$2,name=$3,time=$4,free_text=$5,active=$6 WHERE id=$1",[q.params.id,parseInt(b.sort)||0,n,String(b.time||"").trim(),!!b.free_text,!!b.active]);r.json({ok:true})}));
const ROLES=["Admin","GA","HR"];
app.get("/admin/api/users",admin,A(async(_,r)=>r.json((await Q("SELECT id,name,email,role,active FROM users ORDER BY id")).rows)));
app.post("/admin/api/users",admin,A(async(q,r)=>{const b=q.body,e=String(b.email||"").trim().toLowerCase(),n=String(b.name||"").trim(),p=String(b.password||"");
  if(!n||!/^\S+@\S+\.\S+$/.test(e)||p.length<8||!ROLES.includes(b.role))return r.status(400).json({error:"กรอกชื่อ อีเมล สิทธิ์ และรหัสผ่านอย่างน้อย 8 ตัวอักษรให้ครบ"});
  if((await Q("SELECT 1 FROM users WHERE email=$1",[e])).rowCount)return r.status(400).json({error:"อีเมลนี้มีผู้ใช้แล้ว"});
  await Q("INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4)",[n,e,hash(p),b.role]);r.json({ok:true})}));
app.put("/admin/api/users/:id",admin,A(async(q,r)=>{const b=q.body,id=+q.params.id;
  if(id===q.user.id&&((b.role&&b.role!=="Admin")||b.active===false))return r.status(400).json({error:"ไม่สามารถลดสิทธิ์หรือปิดบัญชีของตัวเอง"});
  if(b.role&&!ROLES.includes(b.role))return r.status(400).json({error:"สิทธิ์ไม่ถูกต้อง"});
  if(b.password!==undefined){if(String(b.password).length<8)return r.status(400).json({error:"รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร"});await Q("UPDATE users SET password_hash=$2 WHERE id=$1",[id,hash(String(b.password))])}
  if(b.role)await Q("UPDATE users SET role=$2 WHERE id=$1",[id,b.role]);
  if(typeof b.active==="boolean")await Q("UPDATE users SET active=$2 WHERE id=$1",[id,b.active]);r.json({ok:true})}));
app.get("/admin/api/employees",admin,A(async(_,r)=>r.json((await Q("SELECT count(*) FILTER(WHERE active)::int active,count(*)::int total FROM employees")).rows[0])));
app.post("/admin/api/employees/import",admin,express.raw({type:"application/octet-stream",limit:"8mb"}),A(async(q,r)=>{
  const wb=new ExcelJS.Workbook();await wb.xlsx.load(q.body);const ws=wb.worksheets[0],cols={};
  ws.getRow(1).eachCell((c,i)=>cols[String(c.value).trim().toLowerCase()]=i);
  if(!cols.staff_no||!cols.nametha)return r.status(400).json({error:"ไม่พบคอลัมน์ Staff_No และ NameTHA ในแถวแรก"});
  const v=(row,k)=>{const x=row.getCell(cols[k]||999).value;return x==null?"":String(x.text??x).trim()},m=new Map();
  ws.eachRow((row,i)=>{if(i===1)return;const id=v(row,"staff_no");if(id&&v(row,"nametha"))m.set(id,[v(row,"nametha"),v(row,"org_desc"),v(row,"post_desc")])});
  const ids=[...m.keys()];if(!ids.length)return r.status(400).json({error:"ไม่พบข้อมูลพนักงานในไฟล์"});
  await Q(`INSERT INTO employees(staff_no,name,org,post,active) SELECT a,b,c,d,true FROM unnest($1::text[],$2::text[],$3::text[],$4::text[]) t(a,b,c,d)
   ON CONFLICT(staff_no) DO UPDATE SET name=EXCLUDED.name,org=EXCLUDED.org,post=EXCLUDED.post,active=true`,[ids,ids.map(i=>m.get(i)[0]),ids.map(i=>m.get(i)[1]),ids.map(i=>m.get(i)[2])]);
  let off=0;if(q.query.deactivate==="1")off=(await Q("UPDATE employees SET active=false WHERE active AND staff_no<>ALL($1)",[ids])).rowCount;
  r.json({imported:ids.length,deactivated:off})}));
const scope=b=>b.all?["",[]]:D.test(b.from)&&D.test(b.to)?["WHERE service_date BETWEEN $1 AND $2",[b.from,b.to]]:null;
app.post("/admin/api/purge/preview",admin,A(async(q,r)=>{const s=scope(q.body);if(!s)return r.status(400).json({error:"เลือกช่วงวันที่"});r.json({count:(await Q("SELECT count(*)::int n FROM registrations "+s[0],s[1])).rows[0].n})}));
app.post("/admin/api/purge",admin,A(async(q,r)=>{const s=scope(q.body);if(!s||q.body.confirm!=="ล้างข้อมูล")return r.status(400).json({error:"ยืนยันไม่ถูกต้อง"});r.json({deleted:(await Q("DELETE FROM registrations "+s[0],s[1])).rowCount})}));

app.use(express.static(path.join(__dirname,"public"),{index:"index.html",extensions:["html"]}));
app.use((e,_q,r,_n)=>{console.error(e);r.status(500).json({error:"server_error"})});
initDb().then(()=>app.listen(PORT,()=>console.log("listening",PORT))).catch(e=>{console.error("DB init failed",e);process.exit(1)});
