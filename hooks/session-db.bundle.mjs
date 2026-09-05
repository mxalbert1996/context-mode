import{createRequire as le}from"node:module";import{existsSync as ge,unlinkSync as H,renameSync as Ee}from"node:fs";import{tmpdir as me}from"node:os";import{join as _e}from"node:path";var I=class{#e;constructor(e){this.#e=e}pragma(e){let r=this.#e.prepare(`PRAGMA ${e}`).all();if(!r||r.length===0)return;if(r.length>1)return r;let s=Object.values(r[0]);return s.length===1?s[0]:r[0]}exec(e){let t="",r=null;for(let i=0;i<e.length;i++){let a=e[i];if(r)t+=a,a===r&&(r=null);else if(a==="'"||a==='"')t+=a,r=a;else if(a===";"){let u=t.trim();u&&this.#e.prepare(u).run(),t=""}else t+=a}let s=t.trim();return s&&this.#e.prepare(s).run(),this}prepare(e){let t=this.#e.prepare(e);return{run:(...r)=>t.run(...r),get:(...r)=>{let s=t.get(...r);return s===null?void 0:s},all:(...r)=>t.all(...r),iterate:(...r)=>t.iterate(...r)}}transaction(e){return this.#e.transaction(e)}close(){this.#e.close()}},M=class{#e;constructor(e){this.#e=e}pragma(e){let r=this.#e.prepare(`PRAGMA ${e}`).all();if(!r||r.length===0)return;if(r.length>1)return r;let s=Object.values(r[0]);return s.length===1?s[0]:r[0]}exec(e){return this.#e.exec(e),this}prepare(e){let t=this.#e.prepare(e);return{run:(...r)=>t.run(...r),get:(...r)=>t.get(...r),all:(...r)=>t.all(...r),iterate:(...r)=>typeof t.iterate=="function"?t.iterate(...r):t.all(...r)[Symbol.iterator]()}}transaction(e){return(...t)=>{this.#e.exec("BEGIN");try{let r=e(...t);return this.#e.exec("COMMIT"),r}catch(r){throw this.#e.exec("ROLLBACK"),r}}}close(){this.#e.close()}},y=null;function pe(n){let e=null;try{return e=new n(":memory:"),e.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)"),!0}catch{return!1}finally{try{e?.close()}catch{}}}function Se(n,e){let t=e!==void 0?e:globalThis.Bun;if(typeof t<"u"&&t!==null)return!0;let r=n??process.versions,[s,i]=(r.node??"0.0.0").split("."),a=Number(s),u=Number(i);return!Number.isFinite(a)||!Number.isFinite(u)?!1:a>22||a===22&&u>=5}function fe(){if(!y){let n=le(import.meta.url);if(globalThis.Bun){let e=n(["bun","sqlite"].join(":")).Database;y=function(r,s){let i=new e(r,{readonly:s?.readonly,create:!0}),a=new I(i);return s?.timeout&&a.pragma(`busy_timeout = ${s.timeout}`),a}}else if(Se()){let e=null;try{({DatabaseSync:e}=n(["node","sqlite"].join(":")))}catch{e=null}e&&pe(e)?y=function(r,s){let i=new e(r,{readOnly:s?.readonly??!1}),a=new M(i);return s?.timeout&&a.pragma(`busy_timeout = ${s.timeout}`),a}:y=n("better-sqlite3")}else y=n("better-sqlite3")}return y}function F(n,e=process.env){n.pragma("journal_mode = WAL"),n.pragma("synchronous = NORMAL");let t=ye(e);if(t!==null)try{n.pragma(`mmap_size = ${t}`)}catch{}}function ye(n=process.env){let e=n.CONTEXT_MODE_DB_MMAP_SIZE;if(e==null)return null;let t=String(e).trim();if(t==="")return null;let r=Number(t);return!Number.isFinite(r)||!Number.isInteger(r)||r<0?null:r}function B(n){if(!ge(n))for(let e of["-wal","-shm"])try{H(n+e)}catch{}}function he(n){for(let e of["","-wal","-shm"])try{H(n+e)}catch{}}function U(n){try{n.close()}catch{}}function $(n="context-mode"){return _e(me(),`${n}-${process.pid}.db`)}function W(n){if(n instanceof Error){let e=n.code;return typeof e=="string"?`${e} ${n.message}`:n.message}if(typeof n=="string")return n;if(n!==null&&typeof n=="object"){let e=n.code,t=n.message,r=[typeof e=="string"?e:"",typeof t=="string"?t:""].filter(Boolean);return r.length>0?r.join(" "):String(n)}return String(n)}function Te(n){let e=W(n);return e.includes("SQLITE_BUSY")||e.includes("database is locked")||e.includes("SQLITE_IOERR")||/disk i\/o error/i.test(e)}function ve(n,e=[100,500,2e3]){let t;for(let r=0;r<=e.length;r++)try{return n()}catch(s){if(!Te(s))throw s;if(t=s instanceof Error?s:new Error(W(s)),r<e.length){let i=e[r],a=Date.now();for(;Date.now()-a<i;);}}throw new Error(`SQLITE_BUSY/SQLITE_IOERR: transient SQLite error after ${e.length} retries. Original error: ${t?.message}`)}function Re(n){return n.includes("SQLITE_CORRUPT")||n.includes("SQLITE_NOTADB")||n.includes("database disk image is malformed")||n.includes("file is not a database")}function be(n){let e=Date.now();for(let t of["","-wal","-shm"])try{Ee(n+t,`${n}${t}.corrupt-${e}`)}catch{}}var De="[context-mode:db]",j=3e4,V=256,m=new Map;function Le(n){if(n instanceof Error){let e=n.code;return typeof e=="string"?e:""}if(n!==null&&typeof n=="object"){let e=n.code;return typeof e=="string"?e:""}return""}function Ne(n){if(n instanceof Error)return n.message;if(typeof n=="string")return n;if(n!==null&&typeof n=="object"){let e=n.message;if(typeof e=="string"&&e)return e}return String(n)}function l(n,e,t,r=Date.now()){try{let s=Le(e),i=Ne(e),a=t?` (${t})`:"",u=`${n}|${s}|${i}${a}`,d=m.get(u);if(d!==void 0&&r-d<j)return;if(m.set(u,r),m.size>V){for(let[E,L]of m)r-L>=j&&m.delete(E);for(;m.size>V;){let E=m.keys().next().value;if(E===void 0)break;m.delete(E)}}let c=process.env.OPENCODE_DEBUG,p=c!==void 0&&c!==""&&c!=="0"&&c!=="false"&&e instanceof Error&&e.stack?`
${e.stack}`:"",f=s?` [${s}]`:"";console.error(`${De} ${n}${f}: ${i}${a}${p}`)}catch{}}var R=Symbol.for("__context_mode_live_dbs_v3__"),x=(()=>{let n=globalThis;return n[R]||(n[R]=new Set,process.on("exit",()=>{for(let e of n[R])U(e);n[R].clear()})),n[R]})(),N=class{#e;#t;constructor(e){let t=fe();this.#e=e,B(e);let r;try{r=new t(e,{timeout:3e4}),F(r)}catch(s){let i=s instanceof Error?s.message:String(s);if(Re(i)){l("SQLiteBase.open",s,e),be(e),B(e);try{r=new t(e,{timeout:3e4}),F(r)}catch(a){throw new Error(`Failed to create fresh DB after renaming corrupt file: ${a instanceof Error?a.message:String(a)}`)}}else throw s}this.#t=r,x.add(this.#t),this.initSchema(),this.prepareStatements()}get db(){return this.#t}get dbPath(){return this.#e}close(){x.delete(this.#t),U(this.#t)}withRetry(e){return ve(e)}cleanup(){x.delete(this.#t),U(this.#t),he(this.#e)}};import{createHash as b}from"node:crypto";import{execFileSync as Ce}from"node:child_process";import{accessSync as Oe,constants as Ae,existsSync as A,mkdirSync as we,realpathSync as xe,renameSync as k}from"node:fs";import{homedir as Q}from"node:os";import{dirname as Ie,isAbsolute as J,join as _,resolve as T}from"node:path";var g="CONTEXT_MODE_DIR",Z="sessions",X="content",D=class extends Error{kind;path;overrideEnvVar;ignoredEnvVar;ignoredReason;constructor(e,t,r=g,s,i,a={}){super(i??Fe(e,t,a),{cause:s}),this.name="StorageDirectoryError",this.kind=e,this.path=t,this.overrideEnvVar=r,this.ignoredEnvVar=a.ignoredEnvVar,this.ignoredReason=a.ignoredReason}},O=new Map;function rt(n){let e=n.env??process.env,t=n.legacySessionDirEnv,r=t?e[t]?.trim():void 0;return r&&t?(n.onLegacySessionDir?.(t,r),r):_(Me(n.configDir,n.configDirEnv,e),"context-mode","sessions")}function Me(n,e,t){let r=e?t[e]:void 0;return r&&r.trim()!==""?q(r.trim()):q(n,Q())}function q(n,e){return n.startsWith("~")?T(Q(),n.replace(/^~[/\\]?/,"")):J(n)?T(n):e?T(e,n):T(n)}function Ue(n,e,t){return new D(n,e,g,void 0,[`Invalid ${g} for context-mode ${n} directory: ${t}`,re()].join(`
`))}function ee(n){let e=process.env[g];if(e===void 0)return{kind:"unset"};let t=e.trim();if(!t)return{kind:"ignored-empty",ignoredEnvVar:g,ignoredReason:"empty"};if(!J(t))throw Ue(n,t,`${g} must be an absolute path.`);return{kind:"override",root:T(t)}}function ke(n){return n.kind==="ignored-empty"?{ignoredEnvVar:n.ignoredEnvVar,ignoredReason:n.ignoredReason}:{}}function te(n,e){let t=ee(n);return t.kind!=="override"?null:{kind:n,path:_(t.root,e),envVar:g,source:"override"}}function Pe(n,e,t){return{kind:n,path:T(e()),envVar:null,source:"default",...t}}function ne(n){let e=ee("session");return e.kind==="override"?{kind:"session",path:_(e.root,Z),envVar:g,source:"override"}:Pe("session",n,ke(e))}function st(n){let e=te("content",X);if(e)return e;let t=ne(n);return{kind:"content",path:_(Ie(t.path),X),envVar:t.envVar,source:t.source,ignoredEnvVar:t.ignoredEnvVar,ignoredReason:t.ignoredReason}}function ot(n){let e=te("stats",Z);if(e)return e;let t=ne(n);return{kind:"stats",path:t.path,envVar:t.envVar,source:t.source,ignoredEnvVar:t.ignoredEnvVar,ignoredReason:t.ignoredReason}}function it(n){return n.message}function at(n){return n.source==="override"&&n.envVar?`via ${n.envVar}`:n.ignoredEnvVar&&n.ignoredReason==="empty"?`default; ignored empty ${n.ignoredEnvVar}`:"default"}function ct(){O.clear()}function ut(n){let e=[n.kind,n.path,n.source,n.envVar??"",n.ignoredEnvVar??"",n.ignoredReason??""].join("\0"),t=O.get(e);if(t instanceof D)throw t;if(t===n.path)return t;try{return we(n.path,{recursive:!0}),Oe(n.path,Ae.W_OK),O.set(e,n.path),n.path}catch(r){let s=new D(n.kind,je(r)??n.path,g,r,void 0,{ignoredEnvVar:n.ignoredEnvVar,ignoredReason:n.ignoredReason});throw O.set(e,s),s}}function Fe(n,e,t={}){return[`context-mode ${n} directory is not writable: ${e}`,Be(t),re()].filter(Boolean).join(`
`)}function Be(n){return n.ignoredEnvVar&&n.ignoredReason==="empty"?`Ignored empty ${n.ignoredEnvVar}; using adapter default.`:null}function re(){return`Set ${g} to a writable absolute path.`}function je(n){if(!n||typeof n!="object")return null;let e=n.path;return typeof e=="string"&&e.length>0?e:null}var h;function S(n){let e=n.replace(/\\/g,"/");return/^\/+$/.test(e)?"/":/^[A-Za-z]:\/+$/.test(e)?`${e.slice(0,2)}/`:e.replace(/\/+$/,"")}function G(n){let e=n;try{e=xe.native(n)}catch{}let t=S(e);return process.platform==="win32"||process.platform==="darwin"?t.toLowerCase():t}function se(n,e){return Ce("git",["-C",n,...e],{encoding:"utf-8",timeout:2e3,stdio:["ignore","pipe","ignore"]}).trim()}function Ve(n){let e=se(n,["rev-parse","--show-toplevel"]);return e.length>0?S(e):null}function He(n){let e=se(n,["worktree","list","--porcelain"]).split(/\r?\n/).find(t=>t.startsWith("worktree "))?.replace("worktree ","")?.trim();return e?S(e):null}function $e(n=process.cwd()){let e=process.env.CONTEXT_MODE_SESSION_SUFFIX;if(h&&h.projectDir===n&&h.envSuffix===e)return h.suffix;let t="";if(e!==void 0)t=e?`__${e}`:"";else try{let r=Ve(n),s=He(n);if(r&&s){let i=G(r),a=G(s);i!==a&&(t=`__${b("sha256").update(i).digest("hex").slice(0,8)}`)}}catch{}return h={projectDir:n,envSuffix:e,suffix:t},t}function dt(){h=void 0}function oe(n){return b("sha256").update(S(n)).digest("hex").slice(0,16)}function ie(n){let e=S(n),t=process.platform==="darwin"||process.platform==="win32"?e.toLowerCase():e;return b("sha256").update(t).digest("hex").slice(0,16)}function lt(n){let{projectDir:e,contentDir:t}=n,r=ie(e),s=_(t,`${r}.db`);if(A(s))return s;let i=oe(e);if(i===r)return s;let a=_(t,`${i}.db`);if(A(a))try{k(a,s);for(let u of["-wal","-shm"])try{k(a+u,s+u)}catch{}}catch{}return s}function gt(n){return We({...n,ext:".db"})}function We(n){let{projectDir:e,sessionsDir:t,ext:r}=n,s=n.suffix??$e(e),i=ie(e),a=_(t,`${i}${s}${r}`);if(A(a))return a;let u=oe(e);if(u===i)return a;let d=_(t,`${u}${s}${r}`);if(A(d))try{k(d,a)}catch{}return a}var Y=1e3,K=5;function C(n){let e=Number(n);return!Number.isFinite(e)||e<=0?0:Math.floor(e)}var o={insertEvent:"insertEvent",getEvents:"getEvents",getEventsByType:"getEventsByType",getEventsByPriority:"getEventsByPriority",getEventsByTypeAndPriority:"getEventsByTypeAndPriority",getEventCount:"getEventCount",getLatestAttributedProject:"getLatestAttributedProject",checkDuplicate:"checkDuplicate",evictLowestPriority:"evictLowestPriority",updateMetaLastEvent:"updateMetaLastEvent",ensureSession:"ensureSession",getSessionStats:"getSessionStats",getSessionRollup:"getSessionRollup",getMaxFileEdits:"getMaxFileEdits",getLatestCommitMessage:"getLatestCommitMessage",incrementCompactCount:"incrementCompactCount",getUsageCursor:"getUsageCursor",setUsageCursor:"setUsageCursor",upsertResume:"upsertResume",getResume:"getResume",markResumeConsumed:"markResumeConsumed",claimLatestUnconsumedResume:"claimLatestUnconsumedResume",deleteEvents:"deleteEvents",deleteMeta:"deleteMeta",deleteResume:"deleteResume",getOldSessions:"getOldSessions",searchEvents:"searchEvents",incrementToolCall:"incrementToolCall",getToolCallTotals:"getToolCallTotals",getToolCallByTool:"getToolCallByTool",getEventBytesSummary:"getEventBytesSummary"},Xe=[["project_dir","TEXT NOT NULL DEFAULT ''"],["attribution_source","TEXT NOT NULL DEFAULT 'unknown'"],["attribution_confidence","REAL NOT NULL DEFAULT 0"],["bytes_avoided","INTEGER NOT NULL DEFAULT 0"],["bytes_returned","INTEGER NOT NULL DEFAULT 0"]];function ae(n){let e=n.pragma("table_xinfo(session_events)"),t=new Set(e.map(s=>s.name)),r=!1;for(let[s,i]of Xe)t.has(s)||(n.exec(`ALTER TABLE session_events ADD COLUMN ${s} ${i}`),r=!0);return r&&n.exec("CREATE INDEX IF NOT EXISTS idx_session_events_project ON session_events(session_id, project_dir)"),r}function Et(n,e){let t=null;try{t=new e(n),ae(t)}catch(r){l("ensureSessionEventsSchema",r,n)}finally{try{t?.close()}catch{}}}var z=class extends N{constructor(e){super(e?.dbPath??$("session"))}stmt(e){return this.stmts.get(e)}initSchema(){try{let t=(this.db.pragma("table_xinfo(session_events)")??[]).find(r=>r.name==="data_hash");t&&t.hidden!==0&&this.db.exec("DROP TABLE session_events")}catch(e){l("SessionDB.initSchema.dataHashMigration",e,this.dbPath)}this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        data TEXT NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        attribution_source TEXT NOT NULL DEFAULT 'unknown',
        attribution_confidence REAL NOT NULL DEFAULT 0,
        bytes_avoided INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        source_hook TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        data_hash TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(session_id, type);
      CREATE INDEX IF NOT EXISTS idx_session_events_priority ON session_events(session_id, priority);

      CREATE TABLE IF NOT EXISTS session_meta (
        session_id TEXT PRIMARY KEY,
        project_dir TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_event_at TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        compact_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS session_resume (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        snapshot TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        consumed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tool_calls (
        session_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0,
        bytes_returned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, tool)
      );

      CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    `);try{ae(this.db)}catch(e){l("SessionDB.initSchema.migrateColumns",e,this.dbPath)}try{(this.db.pragma("table_xinfo(session_meta)")??[]).some(t=>t.name==="usage_cursor")||this.db.exec("ALTER TABLE session_meta ADD COLUMN usage_cursor TEXT")}catch(e){l("SessionDB.initSchema.usageCursorMigration",e,this.dbPath)}}prepareStatements(){this.stmts=new Map;let e=(t,r)=>{this.stmts.set(t,this.db.prepare(r))};e(o.insertEvent,`INSERT INTO session_events (
         session_id, type, category, priority, data,
         project_dir, attribution_source, attribution_confidence,
         bytes_avoided, bytes_returned,
         source_hook, data_hash
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),e(o.getEvents,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? ORDER BY id ASC LIMIT ?`),e(o.getEventsByType,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? ORDER BY id ASC LIMIT ?`),e(o.getEventsByPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),e(o.getEventsByTypeAndPriority,`SELECT id, session_id, type, category, priority, data,
              project_dir, attribution_source, attribution_confidence,
              bytes_avoided, bytes_returned,
              source_hook, created_at, data_hash
       FROM session_events WHERE session_id = ? AND type = ? AND priority >= ? ORDER BY id ASC LIMIT ?`),e(o.getEventCount,"SELECT COUNT(*) AS cnt FROM session_events WHERE session_id = ?"),e(o.getLatestAttributedProject,`SELECT project_dir
       FROM session_events
       WHERE session_id = ? AND project_dir != ''
       ORDER BY id DESC
       LIMIT 1`),e(o.checkDuplicate,`SELECT 1 FROM (
         SELECT type, data_hash FROM session_events
         WHERE session_id = ? ORDER BY id DESC LIMIT ?
       ) AS recent
       WHERE recent.type = ? AND recent.data_hash = ?
       LIMIT 1`),e(o.evictLowestPriority,`DELETE FROM session_events WHERE id = (
         SELECT id FROM session_events WHERE session_id = ?
         ORDER BY priority ASC, id ASC LIMIT 1
       )`),e(o.updateMetaLastEvent,`UPDATE session_meta
       SET last_event_at = datetime('now'), event_count = event_count + 1
       WHERE session_id = ?`),e(o.ensureSession,"INSERT OR IGNORE INTO session_meta (session_id, project_dir) VALUES (?, ?)"),e(o.getSessionStats,`SELECT session_id, project_dir, started_at, last_event_at, event_count, compact_count
       FROM session_meta WHERE session_id = ?`),e(o.getSessionRollup,`SELECT
         COUNT(*) AS tool_calls,
         COALESCE(SUM(CASE WHEN category = 'error' THEN 1 ELSE 0 END), 0) AS errors,
         COUNT(DISTINCT type) AS unique_tools,
         COUNT(DISTINCT CASE WHEN category = 'file' THEN data END) AS unique_files,
         CASE WHEN SUM(CASE WHEN type = 'git_commit' THEN 1 ELSE 0 END) > 0 THEN 1 ELSE 0 END AS has_commit,
         CAST(COALESCE((MAX(strftime('%s', created_at)) - MIN(strftime('%s', created_at))) / 60.0, 0) AS INTEGER) AS duration_min,
         COALESCE(SUM(CASE WHEN type = 'external_ref' THEN 1 ELSE 0 END), 0) AS sources_indexed,
         CAST(COALESCE(SUM(bytes_avoided) / 1024.0, 0) AS INTEGER) AS total_chunks,
         COALESCE(SUM(CASE WHEN type IN ('file_search', 'file_glob') THEN 1 ELSE 0 END), 0) AS search_queries
       FROM session_events
       WHERE session_id = ?`),e(o.getMaxFileEdits,`SELECT COALESCE(MAX(c), 0) AS max_file_edits
       FROM (
         SELECT COUNT(*) AS c
         FROM session_events
         WHERE session_id = ? AND category = 'file' AND type IN ('file_edit', 'file_write')
         GROUP BY data
       )`),e(o.getLatestCommitMessage,`SELECT data
       FROM session_events
       WHERE session_id = ? AND type = 'git_commit'
       ORDER BY id DESC
       LIMIT 1`),e(o.incrementCompactCount,"UPDATE session_meta SET compact_count = compact_count + 1 WHERE session_id = ?"),e(o.getUsageCursor,"SELECT usage_cursor FROM session_meta WHERE session_id = ?"),e(o.setUsageCursor,"UPDATE session_meta SET usage_cursor = ? WHERE session_id = ?"),e(o.upsertResume,`INSERT INTO session_resume (session_id, snapshot, event_count)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         snapshot = excluded.snapshot,
         event_count = excluded.event_count,
         created_at = datetime('now'),
         consumed = 0`),e(o.getResume,"SELECT snapshot, event_count, consumed FROM session_resume WHERE session_id = ?"),e(o.markResumeConsumed,"UPDATE session_resume SET consumed = 1 WHERE session_id = ?"),e(o.claimLatestUnconsumedResume,`UPDATE session_resume
       SET consumed = 1
       WHERE id = (
         SELECT id FROM session_resume
         WHERE consumed = 0
           AND session_id != ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING session_id, snapshot`),e(o.deleteEvents,"DELETE FROM session_events WHERE session_id = ?"),e(o.deleteMeta,"DELETE FROM session_meta WHERE session_id = ?"),e(o.deleteResume,"DELETE FROM session_resume WHERE session_id = ?"),e(o.searchEvents,`SELECT id, session_id, category, type, data, created_at
       FROM session_events
       WHERE (project_dir = ? OR project_dir = '')
         AND (data LIKE '%' || ? || '%' ESCAPE '\\' OR category LIKE '%' || ? || '%' ESCAPE '\\')
         AND (? IS NULL OR category = ?)
       ORDER BY id ASC
       LIMIT ?`),e(o.getOldSessions,"SELECT session_id FROM session_meta WHERE started_at < datetime('now', ? || ' days')"),e(o.incrementToolCall,`INSERT INTO tool_calls (session_id, tool, calls, bytes_returned)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(session_id, tool) DO UPDATE SET
         calls = calls + 1,
         bytes_returned = bytes_returned + excluded.bytes_returned,
         updated_at = datetime('now')`),e(o.getToolCallTotals,`SELECT COALESCE(SUM(calls), 0) AS calls,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM tool_calls WHERE session_id = ?`),e(o.getToolCallByTool,`SELECT tool, calls, bytes_returned
       FROM tool_calls WHERE session_id = ? ORDER BY calls DESC`),e(o.getEventBytesSummary,`SELECT COALESCE(SUM(bytes_avoided), 0) AS bytes_avoided,
              COALESCE(SUM(bytes_returned), 0) AS bytes_returned
       FROM session_events WHERE session_id = ?`)}insertEvent(e,t,r="PostToolUse",s,i){let a=b("sha256").update(t.data).digest("hex").slice(0,16).toUpperCase(),u=String(s?.projectDir??t.project_dir??this._getSessionProjectDir(e)).trim(),d=String(s?.source??t.attribution_source??"unknown"),c=Number(s?.confidence??t.attribution_confidence??0),v=Number.isFinite(c)?Math.max(0,Math.min(1,c)):0,p=C(i?.bytesAvoided),f=C(i?.bytesReturned),E=this.db.transaction(()=>{if(this.stmt(o.checkDuplicate).get(e,K,t.type,a))return;this.stmt(o.getEventCount).get(e).cnt>=Y&&this.stmt(o.evictLowestPriority).run(e),this.stmt(o.insertEvent).run(e,t.type,t.category,t.priority,t.data,u,d,v,p,f,r,a),this.stmt(o.updateMetaLastEvent).run(e)});this.withRetry(()=>E())}bulkInsertEvents(e,t,r="PostToolUse",s,i){if(!t||t.length===0)return;if(t.length===1){this.insertEvent(e,t[0],r,s?.[0],i?.[0]);return}let a=t.map((d,c)=>{let v=b("sha256").update(d.data).digest("hex").slice(0,16).toUpperCase(),p=s?.[c],f=String(p?.projectDir??d.project_dir??this._getSessionProjectDir(e)??"").trim(),E=f===""?"":S(f),L=String(p?.source??d.attribution_source??"unknown"),w=Number(p?.confidence??d.attribution_confidence??0),ce=Number.isFinite(w)?Math.max(0,Math.min(1,w)):0,P=i?.[c],ue=C(P?.bytesAvoided),de=C(P?.bytesReturned);return{event:d,dataHash:v,projectDir:E,attributionSource:L,attributionConfidence:ce,bytesAvoided:ue,bytesReturned:de}}),u=this.db.transaction(()=>{let d=this.stmt(o.getEventCount).get(e).cnt;for(let c of a)this.stmt(o.checkDuplicate).get(e,K,c.event.type,c.dataHash)||(d>=Y?this.stmt(o.evictLowestPriority).run(e):d++,this.stmt(o.insertEvent).run(e,c.event.type,c.event.category,c.event.priority,c.event.data,c.projectDir,c.attributionSource,c.attributionConfidence,c.bytesAvoided,c.bytesReturned,r,c.dataHash));this.stmt(o.updateMetaLastEvent).run(e)});this.withRetry(()=>u())}getEvents(e,t){let r=t?.limit??1e3,s=t?.type,i=t?.minPriority;return s&&i!==void 0?this.stmt(o.getEventsByTypeAndPriority).all(e,s,i,r):s?this.stmt(o.getEventsByType).all(e,s,r):i!==void 0?this.stmt(o.getEventsByPriority).all(e,i,r):this.stmt(o.getEvents).all(e,r)}getEventCount(e){return this.stmt(o.getEventCount).get(e).cnt}getEventBytesSummary(e){let t=this.stmt(o.getEventBytesSummary).get(e);return{bytesAvoided:Number(t?.bytes_avoided??0),bytesReturned:Number(t?.bytes_returned??0)}}getLatestAttributedProjectDir(e){return this.stmt(o.getLatestAttributedProject).get(e)?.project_dir||null}_getSessionProjectDir(e){try{return this.db.prepare("SELECT project_dir FROM session_meta WHERE session_id = ?").get(e)?.project_dir||""}catch(t){return l("SessionDB.getSessionProjectDir",t,this.dbPath),""}}searchEvents(e,t,r,s){try{let i=e.replace(/[%_]/g,u=>"\\"+u),a=s??null;return this.stmt(o.searchEvents).all(r,i,i,a,a,t)}catch(i){return l("SessionDB.searchEvents",i,this.dbPath),[]}}getSessionIdsForProject(e){try{let t=S(e);return this.db.prepare(`SELECT DISTINCT session_id
              FROM session_events
             WHERE RTRIM(REPLACE(project_dir, '\\', '/'), '/') = ?`).all(t).map(s=>s.session_id)}catch(t){return l("SessionDB.getSessionIdsForProject",t,this.dbPath),[]}}ensureSession(e,t){this.stmt(o.ensureSession).run(e,t)}getSessionStats(e){return this.stmt(o.getSessionStats).get(e)??null}getSessionRollup(e){let t=this.stmt(o.getSessionRollup).get(e),r=this.stmt(o.getMaxFileEdits).get(e),s=this.stmt(o.getLatestCommitMessage).get(e),i=this.getSessionStats(e),a=(t?.tool_calls??0)>0?t?.unique_files??0:0,u=t?.errors??0,d=Math.min(a,u);return{tool_calls:t?.tool_calls??0,errors:t?.errors??0,unique_tools:t?.unique_tools??0,unique_files:t?.unique_files??0,max_file_edits:r?.max_file_edits??0,has_commit:t?.has_commit??0,commit_message:s?.data??"",edit_test_cycles:d,duration_min:t?.duration_min??0,compact_count:i?.compact_count??0,sources_indexed:t?.sources_indexed??0,total_chunks:t?.total_chunks??0,search_queries:t?.search_queries??0}}incrementCompactCount(e){this.stmt(o.incrementCompactCount).run(e)}getUsageCursor(e){return this.stmt(o.getUsageCursor).get(e)?.usage_cursor??null}setUsageCursor(e,t){this.stmt(o.setUsageCursor).run(t,e)}upsertResume(e,t,r){this.stmt(o.upsertResume).run(e,t,r??0)}getResume(e){return this.stmt(o.getResume).get(e)??null}markResumeConsumed(e){this.stmt(o.markResumeConsumed).run(e)}claimLatestUnconsumedResume(e){let t=this.stmt(o.claimLatestUnconsumedResume).get(e);return t?{sessionId:t.session_id,snapshot:t.snapshot}:null}getLatestSessionId(){try{return this.db.prepare("SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1").get()?.session_id??null}catch(e){return l("SessionDB.getLatestSessionId",e,this.dbPath),null}}incrementToolCall(e,t,r=0){let s=Number.isFinite(r)&&r>0?Math.round(r):0;try{this.stmt(o.incrementToolCall).run(e,t,s)}catch(i){l("SessionDB.incrementToolCall",i,this.dbPath)}}getToolCallStats(e){try{let t=this.stmt(o.getToolCallTotals).get(e),r=this.stmt(o.getToolCallByTool).all(e),s={};for(let i of r)s[i.tool]={calls:i.calls,bytesReturned:i.bytes_returned};return{totalCalls:t?.calls??0,totalBytesReturned:t?.bytes_returned??0,byTool:s}}catch(t){return l("SessionDB.getToolCallStats",t,this.dbPath),{totalCalls:0,totalBytesReturned:0,byTool:{}}}}deleteSession(e){this.db.transaction(()=>{this.stmt(o.deleteEvents).run(e),this.stmt(o.deleteResume).run(e),this.stmt(o.deleteMeta).run(e)})()}cleanupOldSessions(e=7){let t=`-${e}`,r=this.stmt(o.getOldSessions).all(t);for(let{session_id:s}of r)this.deleteSession(s);return r.length}pruneOrphanedEvents(){let e=this.db.prepare("DELETE FROM session_events WHERE session_id NOT IN (SELECT session_id FROM session_meta)").run();return Number(e.changes??0)}};export{z as SessionDB,D as StorageDirectoryError,dt as _resetWorktreeSuffixCacheForTests,ae as applyMissingSessionEventsColumns,ct as clearStorageDirectoryCheckCacheForTests,at as describeStorageDirectorySource,Et as ensureSessionEventsSchema,ut as ensureWritableStorageDir,it as formatStorageDirectoryError,$e as getWorktreeSuffix,ie as hashProjectDirCanonical,oe as hashProjectDirLegacy,S as normalizeWorktreePath,st as resolveContentStorageDir,lt as resolveContentStorePath,rt as resolveDefaultSessionDir,gt as resolveSessionDbPath,We as resolveSessionPath,ne as resolveSessionStorageDir,ot as resolveStatsStorageDir};
