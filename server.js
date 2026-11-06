const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const initSqlJs = require("sql.js");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, "data", "rchd.sqlite");
const UPLOAD_DIR = path.join(ROOT, "uploads");

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  name: "rchd.sid",
  secret: process.env.SESSION_SECRET || "rchd-local-mvp-change-this-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 100 * 1024 * 1024, files: 10 }
});

let db;
function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}
function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}
function one(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const result = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return result;
}
function many(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function cleanText(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}
function requireTech(req, res, next) {
  if (!req.session.tech) return res.status(401).json({ error: "Faça login para continuar." });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.tech || req.session.tech.role !== "admin")
    return res.status(403).json({ error: "Acesso permitido somente ao administrador." });
  next();
}
function ticketAccess(req, res, next) {
  const ticket = one("SELECT * FROM tickets WHERE id = ?", [Number(req.params.id)]);
  if (!ticket) return res.status(404).json({ error: "Chamado não encontrado." });

  // Quando há token, a requisição é do cliente mesmo que o navegador também
  // tenha uma sessão técnica ativa (cookies são compartilhados por origem).
  const customerToken = req.get("x-customer-token");
  if (customerToken) {
    if (customerToken !== ticket.customer_token)
      return res.status(403).json({ error: "Token inválido para este chamado." });
    req.ticketActor = { type: "customer" };
  } else if (req.session.tech) {
    if (ticket.assigned_to && ticket.assigned_to !== req.session.tech.id) return res.status(403).json({ error: "Este chamado foi transferido e não está mais sob sua responsabilidade." });
    req.ticketActor = { type: "technician", user: req.session.tech };
  } else {
    return res.status(403).json({ error: "Informe o token de acesso ou faça login como técnico." });
  }

  req.ticket = ticket;
  next();
}

(async () => {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(new Uint8Array(fs.readFileSync(DB_FILE)));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS technicians (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'technician',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      company TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      customer_token TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Aberto',
      priority TEXT NOT NULL DEFAULT 'Normal',
      assigned_to INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT DEFAULT NULL,
      resolution_summary TEXT DEFAULT '',
      resolution_report TEXT DEFAULT '',
      machine_ip TEXT DEFAULT '',
      machine_model TEXT DEFAULT '',
      machine_name TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      sender_type TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS internal_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      technician_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      title TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime_type TEXT,
      uploaded_at TEXT NOT NULL,
      message_id INTEGER DEFAULT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket_participants (
      ticket_id INTEGER NOT NULL,
      technician_id INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY(ticket_id, technician_id)
    );
    CREATE TABLE IF NOT EXISTS ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      customer_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      evaluator_type TEXT NOT NULL DEFAULT 'customer',
      technician_id INTEGER DEFAULT NULL
    );
  `);
  // Migrações incrementais para bancos criados em versões anteriores.
  db.run("INSERT OR IGNORE INTO ticket_participants (ticket_id,technician_id,first_seen_at,last_seen_at) SELECT id,assigned_to,created_at,updated_at FROM tickets WHERE assigned_to IS NOT NULL");
  const ensureColumn = (table, column, definition) => {
    const cols = many(`PRAGMA table_info(${table})`);
    if (!cols.some(c => c.name === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  ensureColumn('tickets','closed_at','TEXT DEFAULT NULL');
  ensureColumn('tickets','resolution_summary',"TEXT DEFAULT ''");
  ensureColumn('tickets','resolution_report',"TEXT DEFAULT ''");
  ensureColumn('tickets','machine_ip',"TEXT DEFAULT ''");
  ensureColumn('tickets','machine_model',"TEXT DEFAULT ''");
  ensureColumn('tickets','machine_name',"TEXT DEFAULT ''");
  ensureColumn('internal_notes','title',"TEXT DEFAULT ''");
  ensureColumn('attachments','message_id','INTEGER DEFAULT NULL');
  ensureColumn('ratings','evaluator_type',"TEXT NOT NULL DEFAULT 'customer'");
  ensureColumn('ratings','technician_id','INTEGER DEFAULT NULL');
  db.run("UPDATE ratings SET technician_id=(SELECT assigned_to FROM tickets WHERE tickets.id=ratings.ticket_id) WHERE evaluator_type='customer' AND technician_id IS NULL");
  const schemaVersion = db.exec('PRAGMA user_version')[0]?.values?.[0]?.[0] || 0;
  if (schemaVersion < 2) { db.run("UPDATE ratings SET rating=rating*2 WHERE evaluator_type='customer' AND rating BETWEEN 1 AND 5"); db.run('PRAGMA user_version=2'); }
  const registerParticipant = (ticketId, technicianId, when = new Date().toISOString()) => {
    if (!technicianId) return;
    run("INSERT INTO ticket_participants (ticket_id,technician_id,first_seen_at,last_seen_at) VALUES (?,?,?,?) ON CONFLICT(ticket_id,technician_id) DO UPDATE SET last_seen_at=excluded.last_seen_at", [ticketId,technicianId,when,when]);
  };
  saveDb();

  app.get("/api/health", (req, res) => res.json({ ok: true, app: "RCHD" }));

  // Cliente: abertura e consulta segura do próprio chamado por token.
  app.post("/api/tickets", upload.array("attachments", 10), (req, res) => {
    const name = cleanText(req.body.name, 120);
    const email = cleanText(req.body.email, 180).toLowerCase();
    const company = cleanText(req.body.company, 160);
    const subject = cleanText(req.body.subject, 180);
    const description = cleanText(req.body.description, 4000);
    if (!name || !email || !subject || !description)
      return res.status(400).json({ error: "Preencha nome, e-mail, assunto e descrição." });

    const now = new Date().toISOString();
    const existing = one("SELECT * FROM customers WHERE lower(email) = ?", [email]);
    let customerId;
    if (existing) {
      customerId = existing.id;
      run("UPDATE customers SET name = ?, company = ? WHERE id = ?", [name, company, customerId]);
    } else {
      run("INSERT INTO customers (name,email,company,created_at) VALUES (?,?,?,?)", [name,email,company,now]);
      customerId = one("SELECT last_insert_rowid() AS id").id;
    }
    const token = require("crypto").randomBytes(24).toString("hex");
    run("INSERT INTO tickets (customer_id,customer_token,subject,description,status,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [customerId,token,subject,description,"Aberto","Normal",now,now]);
    const ticketId = one("SELECT last_insert_rowid() AS id").id;
    run("INSERT INTO messages (ticket_id,sender_type,sender_name,body,created_at) VALUES (?,?,?,?,?)",
      [ticketId,"customer",name,description,now]);

    const initialMessageId = one("SELECT id FROM messages WHERE ticket_id=? ORDER BY id DESC LIMIT 1", [ticketId]).id;
    for (const file of (req.files || [])) {
      run("INSERT INTO attachments (ticket_id,original_name,stored_name,mime_type,uploaded_at,message_id) VALUES (?,?,?,?,?,?)",
        [ticketId,file.originalname,file.filename,file.mimetype,now,initialMessageId]);
    }
    res.status(201).json({ id: ticketId, token, subject, status: "Aberto", createdAt: now });
  });

  app.post("/api/customer/tickets/access", (req, res) => {
    const token = cleanText(req.body.token, 100);
    if (!token) return res.status(400).json({ error: "Informe o token de acesso." });
    const ticket = one("SELECT id,subject,status FROM tickets WHERE customer_token = ?", [token]);
    if (!ticket) return res.status(404).json({ error: "Token não encontrado. Confira o código e tente novamente." });
    res.json({ id: ticket.id, subject: ticket.subject, status: ticket.status });
  });

  app.get("/api/tickets/:id", ticketAccess, (req, res) => {
    const t = req.ticket;
    const customer = one("SELECT id,name,email,company,phone FROM customers WHERE id = ?", [t.customer_id]);
    const messages = many("SELECT id,sender_type,sender_name,body,created_at FROM messages WHERE ticket_id = ? ORDER BY id", [t.id]);
    const attachments = many("SELECT id,original_name,mime_type,uploaded_at,message_id FROM attachments WHERE ticket_id = ?", [t.id]);
    const rating = one("SELECT rating,comment,created_at FROM ratings WHERE ticket_id=? AND evaluator_type='customer'", [t.id]);
    res.json({ ...t, customer, messages, attachments, rating });
  });

  app.post("/api/tickets/:id/messages", ticketAccess, (req, res) => {
    const body = cleanText(req.body.body, 4000);
    if (req.ticket.status === "Encerrado") return res.status(409).json({ error: "Este chamado está encerrado e não aceita novas mensagens." });
    if (!body) return res.status(400).json({ error: "Digite uma mensagem." });
    const senderType = req.ticketActor.type;
    const customer = senderType === "customer"
      ? one("SELECT name FROM customers WHERE id = ?", [req.ticket.customer_id])
      : null;
    const senderName = senderType === "technician"
      ? req.ticketActor.user.name
      : (customer?.name || "Cliente");
    const now = new Date().toISOString();
    run("INSERT INTO messages (ticket_id,sender_type,sender_name,body,created_at) VALUES (?,?,?,?,?)",
      [req.ticket.id,senderType,senderName,body,now]);
    if(senderType === 'technician') { run("UPDATE tickets SET updated_at = ?, assigned_to = COALESCE(assigned_to, ?) WHERE id = ?", [now,req.ticketActor.user.id,req.ticket.id]); registerParticipant(req.ticket.id, req.ticketActor.user.id, now); }
    else run("UPDATE tickets SET updated_at = ? WHERE id = ?", [now,req.ticket.id]);
    res.status(201).json({ ok: true });
  });

  // Envio de arquivos em qualquer momento da conversa (documentos, áudio, vídeo e imagens).
  app.post("/api/tickets/:id/attachments", ticketAccess, upload.array("attachments", 10), (req, res) => {
    if (req.ticket.status === "Encerrado") return res.status(409).json({ error: "Este chamado está encerrado." });
    if (!req.files || !req.files.length) return res.status(400).json({ error: "Selecione ao menos um arquivo." });
    const now = new Date().toISOString();
    const actor = req.ticketActor.type;
    const senderName = actor === "technician" ? req.ticketActor.user.name : (one("SELECT name FROM customers WHERE id=?", [req.ticket.customer_id])?.name || "Cliente");
    for (const file of req.files) {
      const label = `📎 ${file.originalname}`;
      run("INSERT INTO messages (ticket_id,sender_type,sender_name,body,created_at) VALUES (?,?,?,?,?)", [req.ticket.id,actor,senderName,label,now]);
      const messageId = one("SELECT last_insert_rowid() AS id").id;
      run("INSERT INTO attachments (ticket_id,original_name,stored_name,mime_type,uploaded_at,message_id) VALUES (?,?,?,?,?,?)", [req.ticket.id,file.originalname,file.filename,file.mimetype,now,messageId]);
    }
    run("UPDATE tickets SET updated_at=? WHERE id=?", [now,req.ticket.id]);
    res.status(201).json({ ok: true, count: req.files.length });
  });

  // Encerramento solicitado pelo cliente e avaliação do atendimento.
  app.post("/api/customer/tickets/:id/close", ticketAccess, (req,res) => {
    if (req.ticketActor.type !== "customer") return res.status(403).json({ error: "Somente o cliente pode usar esta ação." });
    if (req.ticket.status === "Encerrado") return res.json({ ok: true, alreadyClosed: true });
    const now = new Date().toISOString();
    run("UPDATE tickets SET status='Encerrado',closed_at=?,updated_at=? WHERE id=?", [now,now,req.ticket.id]);
    res.json({ ok: true });
  });
  app.post("/api/customer/tickets/:id/rating", ticketAccess, (req,res) => {
    if (req.ticketActor.type !== "customer") return res.status(403).json({ error: "Somente o cliente pode avaliar." });
    const rating = Number(req.body.rating), comment = cleanText(req.body.comment,1500);
    if (!Number.isInteger(rating) || rating < 1 || rating > 10) return res.status(400).json({ error: "Selecione uma nota de 1 a 10." });
    if (one("SELECT id FROM ratings WHERE ticket_id=? AND evaluator_type='customer'", [req.ticket.id])) return res.status(409).json({ error: "Este atendimento já foi avaliado." });
    run("INSERT INTO ratings (ticket_id,customer_id,rating,comment,created_at,evaluator_type,technician_id) VALUES (?,?,?,?,?,'customer',?)", [req.ticket.id,req.ticket.customer_id,rating,comment,new Date().toISOString(),req.ticket.assigned_to || null]);
    res.status(201).json({ ok: true });
  });

  // Autenticação da equipe.
  app.get("/api/setup/status", (req, res) => {
    res.json({ needsAdmin: !one("SELECT id FROM technicians WHERE role = 'admin'") });
  });
  app.post("/api/setup/admin", async (req, res) => {
    if (one("SELECT id FROM technicians WHERE role = 'admin'"))
      return res.status(409).json({ error: "O administrador inicial já foi criado." });
    const name = cleanText(req.body.name, 120);
    const email = cleanText(req.body.email, 180).toLowerCase();
    const password = String(req.body.password || "");
    if (!name || !email || password.length < 8)
      return res.status(400).json({ error: "Informe nome, e-mail e senha com pelo menos 8 caracteres." });
    const hash = await bcrypt.hash(password, 12);
    run("INSERT INTO technicians (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)",
      [name,email,hash,"admin",new Date().toISOString()]);
    res.status(201).json({ ok: true });
  });
  app.post("/api/auth/login", async (req, res) => {
    const email = cleanText(req.body.email, 180).toLowerCase();
    const password = String(req.body.password || "");
    const tech = one("SELECT * FROM technicians WHERE lower(email) = ?", [email]);
    if (!tech || !(await bcrypt.compare(password, tech.password_hash)))
      return res.status(401).json({ error: "E-mail ou senha incorretos." });
    req.session.tech = { id: tech.id, name: tech.name, email: tech.email, role: tech.role };
    res.json({ user: req.session.tech });
  });
  app.post("/api/auth/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));
  app.get("/api/auth/me", (req, res) => res.json({ user: req.session.tech || null }));

  app.get("/api/admin/technicians", requireAdmin, (req,res) => {
    res.json(many("SELECT id,name,email,role,created_at FROM technicians ORDER BY role DESC,name"));
  });
  app.post("/api/admin/technicians", requireAdmin, async (req,res) => {
    const name=cleanText(req.body.name,120), email=cleanText(req.body.email,180).toLowerCase(), password=String(req.body.password||"");
    const role="technician";
    if(!name || !email || password.length<8)return res.status(400).json({error:"Informe nome, e-mail e senha com pelo menos 8 caracteres."});
    if(one("SELECT id FROM technicians WHERE lower(email)=?",[email]))return res.status(409).json({error:"Já existe um usuário com este e-mail."});
    const hash=await bcrypt.hash(password,12);
    run("INSERT INTO technicians (name,email,password_hash,role,created_at) VALUES (?,?,?,?,?)",[name,email,hash,role,new Date().toISOString()]);
    res.status(201).json({ok:true});
  });
  app.get("/api/admin/ratings", requireAdmin, (req,res) => {
    res.json(many(`SELECT r.*,t.subject,c.name AS customer_name,c.email AS customer_email FROM ratings r JOIN tickets t ON t.id=r.ticket_id JOIN customers c ON c.id=r.customer_id WHERE r.evaluator_type='customer' ORDER BY r.created_at DESC`));
  });

  app.get('/api/tech/technicians', requireTech, (req,res) => {
    res.json(many("SELECT id,name,email,role FROM technicians ORDER BY name"));
  });

  app.get("/api/tech/tickets", requireTech, (req, res) => {
    const rows = many(`
      SELECT t.id,t.subject,t.status,t.priority,t.created_at,t.updated_at,
             c.name AS customer_name,c.email AS customer_email,c.company,u.name AS assigned_technician
      FROM tickets t JOIN customers c ON c.id=t.customer_id LEFT JOIN technicians u ON u.id=t.assigned_to
      WHERE t.assigned_to=? OR t.assigned_to IS NULL
      ORDER BY CASE t.status WHEN 'Aberto' THEN 0 WHEN 'Em atendimento' THEN 1 WHEN 'Aguardando cliente' THEN 2 ELSE 3 END,
               t.updated_at DESC
    `, [req.session.tech.id]);
    res.json(rows);
  });
  app.get("/api/tech/notifications", requireTech, (req,res) => {
    const after = Math.max(0, Number(req.query.after) || 0);
    const messages = many(`SELECT m.id,m.ticket_id,m.sender_name,m.body,m.created_at,t.subject FROM messages m JOIN tickets t ON t.id=m.ticket_id WHERE m.id>? AND m.sender_type='customer' AND t.assigned_to=? ORDER BY m.id ASC LIMIT 50`, [after,req.session.tech.id]);
    const maxId = one("SELECT COALESCE(MAX(id),0) AS id FROM messages").id;
    res.json({ maxId, messages });
  });

  app.get("/api/tech/history", requireTech, (req,res) => {
    const rows = many(`SELECT t.id,t.subject,t.status,t.priority,t.created_at,t.updated_at,t.closed_at,t.resolution_summary,t.assigned_to,c.name AS customer_name,c.email AS customer_email,c.company,u.name AS assigned_technician,CASE WHEN t.assigned_to=? THEN 0 ELSE 1 END AS transferred_participation FROM tickets t JOIN customers c ON c.id=t.customer_id LEFT JOIN technicians u ON u.id=t.assigned_to JOIN ticket_participants p ON p.ticket_id=t.id AND p.technician_id=? WHERE (t.status='Encerrado' OR t.assigned_to<>?) ORDER BY COALESCE(t.closed_at,t.updated_at) DESC` , [req.session.tech.id,req.session.tech.id,req.session.tech.id]);
    res.json(rows);
  });
  app.post("/api/tech/tickets/:id/close", requireTech, (req,res) => {
    const id=Number(req.params.id), t=one("SELECT * FROM tickets WHERE id=?",[id]);
    if(!t)return res.status(404).json({error:"Chamado não encontrado."});
    const sections=Array.isArray(req.body.sections)?req.body.sections.map(x=>({title:cleanText(x.title,120),body:cleanText(x.body,2000)})).filter(x=>x.title&&x.body):[];
    const summary=cleanText(req.body.summary,1500) || sections[0]?.title || '';
    const report=sections.length?sections.map(x=>`${x.title}\n${x.body}`).join('\n\n'):cleanText(req.body.report,5000);
    if(!summary || !report)return res.status(400).json({error:"Adicione ao menos um campo de relatório com título e detalhes."});
    const now=new Date().toISOString();
    if(t.assigned_to && t.assigned_to !== req.session.tech.id) return res.status(403).json({error:'Este chamado foi transferido e não está mais sob sua responsabilidade.'});
    run("UPDATE tickets SET status='Encerrado',closed_at=?,updated_at=?,assigned_to=?,resolution_summary=?,resolution_report=?,machine_ip=?,machine_model=?,machine_name=? WHERE id=?",[now,now,req.session.tech.id,summary,report,cleanText(req.body.machine_ip,100),cleanText(req.body.machine_model,180),cleanText(req.body.machine_name,180),id]);
    registerParticipant(id,req.session.tech.id,now);
    res.json({ok:true});
  });

  // Exclusão definitiva do chamado e de seus registros dependentes.
  app.delete("/api/tech/tickets/:id", requireTech, (req, res) => {
    const ticketId = Number(req.params.id);
    const assigned=one('SELECT assigned_to FROM tickets WHERE id=?',[ticketId]);
    if(assigned && assigned.assigned_to!==req.session.tech.id) return res.status(403).json({error:'Este chamado não está mais sob sua responsabilidade.'});
    if (!Number.isInteger(ticketId) || ticketId <= 0)
      return res.status(400).json({ error: "Número de chamado inválido." });
    const ticket = one("SELECT id FROM tickets WHERE id = ?", [ticketId]);
    if (!ticket) return res.status(404).json({ error: "Chamado não encontrado." });

    const files = many("SELECT stored_name FROM attachments WHERE ticket_id = ?", [ticketId]);
    try {
      db.run("BEGIN TRANSACTION");
      db.run("DELETE FROM messages WHERE ticket_id = ?", [ticketId]);
      db.run("DELETE FROM internal_notes WHERE ticket_id = ?", [ticketId]);
      db.run("DELETE FROM attachments WHERE ticket_id = ?", [ticketId]);
      db.run("DELETE FROM tickets WHERE id = ?", [ticketId]);
      db.run("COMMIT");
      saveDb();
    } catch (error) {
      try { db.run("ROLLBACK"); } catch (_) {}
      console.error("Falha ao excluir chamado:", error);
      return res.status(500).json({ error: "Não foi possível excluir o chamado." });
    }

    for (const file of files) {
      const filePath = path.join(UPLOAD_DIR, path.basename(file.stored_name));
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
      catch (error) { console.error("Não foi possível remover anexo:", filePath, error); }
    }
    res.json({ ok: true, deletedId: ticketId });
  });

  app.post('/api/tech/tickets/:id/transfer', requireTech, (req,res) => {
    const ticketId=Number(req.params.id), technicianId=Number(req.body.technician_id);
    const ticket=one('SELECT * FROM tickets WHERE id=?',[ticketId]);
    if(!ticket) return res.status(404).json({error:'Chamado não encontrado.'});
    if(ticket.status==='Encerrado') return res.status(409).json({error:'Chamados encerrados não podem ser transferidos.'});
    if(ticket.assigned_to && ticket.assigned_to!==req.session.tech.id) return res.status(403).json({error:'Este chamado não está mais sob sua responsabilidade.'});
    const nextTech=one("SELECT id,name FROM technicians WHERE id=? AND role IN ('admin','technician')",[technicianId]);
    if(!Number.isInteger(technicianId)||!nextTech) return res.status(400).json({error:'Selecione um técnico válido.'});
    if(technicianId===req.session.tech.id) return res.status(400).json({error:'Selecione outro técnico para transferir o chamado.'});
    const now=new Date().toISOString(), previous=req.session.tech;
    registerParticipant(ticketId,previous.id,now);
    run("UPDATE tickets SET assigned_to=?,status=CASE WHEN status='Aberto' THEN 'Em atendimento' ELSE status END,updated_at=? WHERE id=?",[technicianId,now,ticketId]);
    registerParticipant(ticketId,technicianId,now);
    run("INSERT INTO messages (ticket_id,sender_type,sender_name,body,created_at) VALUES (?,?,?,?,?)",[ticketId,'system','Sistema',`Este chamado foi transferido de ${previous.name} para ${nextTech.name}.`,now]);
    res.json({ok:true});
  });
  app.post('/api/tech/tickets/:id/technician-rating', requireTech, (req,res) => {
    const ticket=one('SELECT * FROM tickets WHERE id=?',[Number(req.params.id)]);
    if(!ticket) return res.status(404).json({error:'Chamado não encontrado.'});
    if(ticket.assigned_to!==req.session.tech.id) return res.status(403).json({error:'Este chamado não está mais sob sua responsabilidade.'});
    if(ticket.status!=='Encerrado') return res.status(409).json({error:'A avaliação técnica fica disponível após o encerramento.'});
    const rating=Number(req.body.rating), comment=cleanText(req.body.comment,1500);
    if(!Number.isInteger(rating)||rating<1||rating>10) return res.status(400).json({error:'Selecione uma nota de 1 a 10.'});
    if(one("SELECT id FROM ratings WHERE ticket_id=? AND evaluator_type='technician'",[ticket.id])) return res.status(409).json({error:'Este chamado já recebeu avaliação técnica.'});
    run("INSERT INTO ratings (ticket_id,customer_id,rating,comment,created_at,evaluator_type,technician_id) VALUES (?,?,?,?,?,'technician',?)",[ticket.id,ticket.customer_id,rating,comment,new Date().toISOString(),req.session.tech.id]);
    res.status(201).json({ok:true});
  });
  app.get('/api/admin/technicians/:id/summary', requireAdmin, (req,res) => {
    const id=Number(req.params.id), tech=one('SELECT id,name,email,role,created_at FROM technicians WHERE id=?',[id]);
    if(!tech) return res.status(404).json({error:'Técnico não encontrado.'});
    const recent=many(`SELECT t.id,t.subject,t.status,t.created_at,t.closed_at,r.rating,r.comment,r.created_at AS rated_at,c.name AS customer_name FROM tickets t LEFT JOIN ratings r ON r.ticket_id=t.id AND r.evaluator_type='customer' LEFT JOIN customers c ON c.id=t.customer_id WHERE t.assigned_to=? ORDER BY t.updated_at DESC LIMIT 12`,[id]);
    const stats=one("SELECT COUNT(*) AS total,ROUND(AVG(rating),1) AS average FROM ratings WHERE technician_id=? AND evaluator_type='customer'",[id]);
    const given=one("SELECT COUNT(*) AS total,ROUND(AVG(rating),1) AS average FROM ratings WHERE technician_id=? AND evaluator_type='technician'",[id]);
    res.json({technician:tech,recent,stats,given});
  });

  app.patch("/api/tech/tickets/:id", requireTech, (req, res) => {
    const current=one('SELECT assigned_to FROM tickets WHERE id=?',[Number(req.params.id)]);
    if(!current) return res.status(404).json({error:'Chamado não encontrado.'});
    if(current.assigned_to && current.assigned_to!==req.session.tech.id) return res.status(403).json({error:'Este chamado não está mais sob sua responsabilidade.'});
    const status = cleanText(req.body.status, 40);
    const priority = cleanText(req.body.priority, 30);
    const allowedStatus = ["Aberto","Em atendimento","Aguardando cliente"];
    const allowedPriority = ["Baixa","Normal","Alta","Urgente"];
    if (!allowedStatus.includes(status) || !allowedPriority.includes(priority))
      return res.status(400).json({ error: "Status ou prioridade inválidos." });
    const now=new Date().toISOString();
    run("UPDATE tickets SET status=?,priority=?,assigned_to=?,updated_at=? WHERE id=?",
      [status,priority,req.session.tech.id,now,Number(req.params.id)]);
    registerParticipant(Number(req.params.id),req.session.tech.id,now);
    res.json({ ok: true });
  });
  app.get("/api/tech/tickets/:id", requireTech, (req, res) => {
    const t = one("SELECT * FROM tickets WHERE id = ?", [Number(req.params.id)]);
    if (!t) return res.status(404).json({ error: "Chamado não encontrado." });
    if(t.assigned_to && t.assigned_to!==req.session.tech.id) return res.status(403).json({error:'Este chamado foi transferido e não está mais disponível para você.'});
    if(!t.assigned_to){const now=new Date().toISOString();run('UPDATE tickets SET assigned_to=?,updated_at=? WHERE id=?',[req.session.tech.id,now,t.id]);registerParticipant(t.id,req.session.tech.id,now);t.assigned_to=req.session.tech.id;}
    const customer = one("SELECT * FROM customers WHERE id = ?", [t.customer_id]);
    const messages = many("SELECT * FROM messages WHERE ticket_id=? ORDER BY id", [t.id]);
    const notes = many("SELECT n.*,u.name AS technician_name FROM internal_notes n JOIN technicians u ON u.id=n.technician_id WHERE n.ticket_id=? ORDER BY n.id DESC", [t.id]);
    const attachments = many("SELECT id,original_name,mime_type,uploaded_at,message_id FROM attachments WHERE ticket_id=?", [t.id]);
    const rating = one("SELECT rating,comment,created_at FROM ratings WHERE ticket_id=? AND evaluator_type='customer'", [t.id]);
    const technician_rating = one("SELECT rating,comment,created_at FROM ratings WHERE ticket_id=? AND evaluator_type='technician'", [t.id]);
    res.json({ ...t, customer, messages, notes, attachments, rating, technician_rating });
  });
  app.post("/api/tech/tickets/:id/notes", requireTech, (req, res) => {
    const ticket=one('SELECT assigned_to FROM tickets WHERE id=?',[Number(req.params.id)]);
    if(!ticket || (ticket.assigned_to && ticket.assigned_to!==req.session.tech.id)) return res.status(403).json({error:'Este chamado não está mais sob sua responsabilidade.'});
    const body = cleanText(req.body.body, 3000);
    const title = cleanText(req.body.title, 120);
    if (!body) return res.status(400).json({ error: "Digite uma anotação." });
    run("INSERT INTO internal_notes (ticket_id,technician_id,body,title,created_at) VALUES (?,?,?,?,?)",
      [Number(req.params.id),req.session.tech.id,body,title,new Date().toISOString()]);
    res.status(201).json({ ok: true });
  });
  app.patch("/api/tech/customers/:id", requireTech, (req, res) => {
    const phone = cleanText(req.body.phone, 50);
    const company = cleanText(req.body.company, 160);
    const notes = cleanText(req.body.notes, 3000);
    run("UPDATE customers SET phone=?,company=?,notes=? WHERE id=?", [phone,company,notes,Number(req.params.id)]);
    res.json({ ok: true });
  });
  app.get("/api/tech/attachments/:id", requireTech, (req, res) => {
    const a = one("SELECT a.*,t.assigned_to FROM attachments a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=?", [Number(req.params.id)]);
    if (!a) return res.status(404).end();
    if(a.assigned_to!==req.session.tech.id) return res.status(403).end();
    if (/^(audio|video|image)\//.test(a.mime_type || "")) return res.sendFile(path.join(UPLOAD_DIR,path.basename(a.stored_name)), { headers: { "Content-Type": a.mime_type } });
    res.download(path.join(UPLOAD_DIR,path.basename(a.stored_name)), a.original_name);
  });
  app.get("/api/customer/attachments/:id", (req, res) => {
    const a = one("SELECT a.*,t.customer_token FROM attachments a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=?", [Number(req.params.id)]);
    if (!a || (req.get("x-customer-token") || req.query.token) !== a.customer_token) return res.status(403).end();
    if (/^(audio|video|image)\//.test(a.mime_type || "")) return res.sendFile(path.join(UPLOAD_DIR,path.basename(a.stored_name)), { headers: { "Content-Type": a.mime_type } });
    res.download(path.join(UPLOAD_DIR,path.basename(a.stored_name)), a.original_name);
  });

  app.use("/client", express.static(path.join(ROOT,"public","client")));
  app.use("/tech", express.static(path.join(ROOT,"public","tech")));
  app.get("/", (req,res) => res.redirect("/client/index.html"));
  app.get("/home.html", (req,res) => res.sendFile(path.join(ROOT,"public","client","home.html")));
  app.get("/index.html", (req,res) => res.sendFile(path.join(ROOT,"public","client","index.html")));
  app.get("/tech.html", (req,res) => res.sendFile(path.join(ROOT,"public","tech","tech.html")));

  app.listen(PORT, () => console.log(`RCHD ativo em http://localhost:${PORT}`));
})().catch(err => { console.error("Falha ao iniciar RCHD:", err); process.exit(1); });