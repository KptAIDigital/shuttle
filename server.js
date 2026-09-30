const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const seed = require("./data/employees.json");

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render internal URL ไม่ต้องใช้ SSL / external URL ต้องใช้
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("localhost") &&
       process.env.DB_SSL !== "false" && /\./.test(new URL(process.env.DATABASE_URL).hostname)
       ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      staff_no TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      org      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS submissions (
      staff_no     TEXT PRIMARY KEY REFERENCES employees(staff_no),
      emp_name     TEXT NOT NULL,
      org          TEXT NOT NULL,
      pickup       TEXT NOT NULL,
      pickup_other TEXT,
      note         TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // นำเข้ารายชื่อพนักงานจาก Excel (ทำครั้งเดียวเมื่อตารางว่าง)
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM employees");
  if (rows[0].n === 0) {
    const ids = Object.keys(seed);
    await pool.query(
      `INSERT INTO employees (staff_no, name, org)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) ON CONFLICT DO NOTHING`,
      [ids, ids.map(i => seed[i].n), ids.map(i => seed[i].o)]
    );
    console.log(`Seeded ${ids.length} employees`);
  }
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "20kb" }));

// จำกัดจำนวนครั้งต่อ IP (ป้องกันการไล่เดารหัส)
const hits = new Map();
function limiter(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.headers["cf-connecting-ip"] || req.ip;
    const rec = (hits.get(ip + req.path) || []).filter(t => now - t < windowMs);
    if (rec.length >= max) return res.status(429).json({ error: "too_many_requests" });
    rec.push(now); hits.set(ip + req.path, rec); next();
  };
}
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();

app.get("/healthz", (_, res) => res.send("ok"));

app.get("/api/lookup", limiter(40, 60_000), async (req, res) => {
  const id = String(req.query.id || "").trim();
  if (!/^\d{1,10}$/.test(id)) return res.status(400).json({ found: false });
  const { rows } = await pool.query(
    `SELECT e.name, e.org, s.pickup, s.pickup_other, s.note
       FROM employees e LEFT JOIN submissions s USING (staff_no) WHERE e.staff_no = $1`, [id]);
  if (!rows.length) return res.status(404).json({ found: false });
  const r = rows[0];
  res.json({ found: true, name: r.name, org: r.org, already: !!r.pickup });
});

const PICKUPS = ["BIG C ราชบุรี (07:00 น.)", "วัดหนองหนอย (07:00 น.)", "เทศบาลเขางู (07:00 น.)", "อื่น ๆ"];

app.post("/api/submit", limiter(10, 60_000), async (req, res) => {
  const b = req.body || {};
  const id = String(b.emp_id || "").trim();
  const pickup = String(b.pickup || "");
  const other = String(b.pickup_other || "").trim().slice(0, 200);
  const note = String(b.note || "").trim().slice(0, 500);
  if (!/^\d{1,10}$/.test(id) || !PICKUPS.includes(pickup) || (pickup === "อื่น ๆ" && !other))
    return res.status(400).json({ error: "invalid" });
  // ชื่อและหน่วยงานดึงจากฐานข้อมูลเสมอ ไม่เชื่อค่าจากหน้าเว็บ
  const e = await pool.query("SELECT name, org FROM employees WHERE staff_no=$1", [id]);
  if (!e.rows.length) return res.status(404).json({ error: "employee_not_found" });
  await pool.query(
    `INSERT INTO submissions (staff_no, emp_name, org, pickup, pickup_other, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (staff_no) DO UPDATE SET
       pickup=EXCLUDED.pickup, pickup_other=EXCLUDED.pickup_other,
       note=EXCLUDED.note, updated_at=now()`,
    [id, e.rows[0].name, e.rows[0].org, pickup, pickup === "อื่น ๆ" ? other : null, note || null]);
  res.json({ ok: true });
});

// ---------- ส่วนผู้ดูแล ----------
function requireAdmin(req, res, next) {
  const challenge = () => { res.set("WWW-Authenticate", 'Basic realm="Admin"'); res.status(401).send("Unauthorized"); };
  if (!ADMIN_PASSWORD) return res.status(503).send("ADMIN_PASSWORD is not set");
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return challenge();
  const [u, ...p] = Buffer.from(h.slice(6), "base64").toString().split(":");
  const eq = (a, b) => { const A = Buffer.from(a), B = Buffer.from(b); return A.length === B.length && crypto.timingSafeEqual(A, B); };
  if (eq(u, ADMIN_USER) && eq(p.join(":"), ADMIN_PASSWORD)) return next();
  challenge();
}
app.use("/admin", requireAdmin);
app.get("/admin", (_, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.get("/admin/api/data", async (_, res) => {
  const list = await pool.query(
    `SELECT staff_no, emp_name, org, pickup, pickup_other, note, created_at, updated_at
       FROM submissions ORDER BY updated_at DESC`);
  const summary = await pool.query(
    `SELECT CASE WHEN pickup='อื่น ๆ' THEN 'อื่น ๆ: ' || pickup_other ELSE pickup END AS pickup, COUNT(*)::int AS n
       FROM submissions GROUP BY 1 ORDER BY n DESC`);
  const total = await pool.query("SELECT COUNT(*)::int AS n FROM employees");
  res.json({ submissions: list.rows, summary: summary.rows, totalEmployees: total.rows[0].n });
});

const csvCell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
app.get("/admin/export.csv", async (req, res) => {
  const notYet = req.query.type === "pending";
  const q = notYet
    ? `SELECT e.staff_no, e.name, e.org, '' AS pickup, '' AS pickup_other, '' AS note, '' AS updated_at
         FROM employees e LEFT JOIN submissions s USING (staff_no) WHERE s.staff_no IS NULL ORDER BY e.org, e.staff_no`
    : `SELECT staff_no, emp_name AS name, org, pickup, pickup_other, note, updated_at FROM submissions ORDER BY pickup, org, staff_no`;
  const { rows } = await pool.query(q);
  const head = ["รหัสพนักงาน", "ชื่อ-นามสกุล", "หน่วยงาน", "จุดรับ-ส่ง", "จุดอื่น ๆ", "หมายเหตุ", "เวลาที่กรอก"];
  const body = rows.map(r => [r.staff_no, r.name, r.org, r.pickup, r.pickup_other, r.note, r.updated_at].map(csvCell).join(","));
  res.set({ "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="${notYet ? "not-submitted" : "submissions"}.csv"` });
  res.send("\ufeff" + [head.map(csvCell).join(","), ...body].join("\r\n"));  // BOM ให้ Excel อ่านภาษาไทยได้
});

app.use(express.static(path.join(__dirname, "public"), { index: "index.html", extensions: ["html"] }));

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: "server_error" }); });

initDb().then(() => app.listen(PORT, () => console.log("listening on", PORT)))
        .catch(e => { console.error("DB init failed", e); process.exit(1); });
