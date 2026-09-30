// SQLite com migracao versionada (PRAGMA user_version). Sem dependencia de 'electron'.
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const hasColumn = (db: DatabaseSync, table: string, col: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some(c => c.name === col)

// Cada item leva o banco da versao i para i+1. Nunca edite um item ja publicado: acrescente outro.
export const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // v1: esquema original (idempotente, pois bancos antigos ja o tem sem user_version)
  db => db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      config_dir TEXT -- NULL = conta padrao (~/.claude)
    );
    CREATE TABLE IF NOT EXISTS pins (
      id INTEGER PRIMARY KEY, game TEXT NOT NULL, title TEXT NOT NULL, body TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'aberto', -- aberto | andamento | feito
      agent TEXT, account_id INTEGER, branch TEXT, worktree TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    -- key = escopo (pin ou pasta do jogo) | agente | conta
    CREATE TABLE IF NOT EXISTS chats (key TEXT PRIMARY KEY, session_id TEXT);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, chat_key TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `),
  // v2: execucoes persistidas (running | completed | failed | cancelled) e estado por mensagem do agente
  db => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, chat_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
        partial TEXT NOT NULL DEFAULT '', error TEXT, category TEXT,
        started_at TEXT DEFAULT CURRENT_TIMESTAMP, ended_at TEXT
      );
    `)
    if (!hasColumn(db, 'messages', 'status')) db.exec('ALTER TABLE messages ADD COLUMN status TEXT')
  },
  // v3: tarefas. O chat pertence a tarefa; sessoes dos provedores sao associacoes separadas (task_sessions).
  // As tabelas antigas (chats, colunas chat_key) continuam intactas como registro do que foi migrado.
  db => {
    db.exec(`
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY, game TEXT NOT NULL, title TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'aberta', -- aberta | andamento | concluida
        legacy TEXT,                          -- origem de tarefas migradas: 'pin' | 'chat'
        pin_id INTEGER, branch TEXT, worktree TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, archived_at TEXT
      );
      CREATE INDEX tasks_game ON tasks (game, updated_at);
      CREATE TABLE task_sessions (
        task_id INTEGER NOT NULL, provider TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '', session_id TEXT NOT NULL,
        PRIMARY KEY (task_id, provider, profile)
      );
      ALTER TABLE messages ADD COLUMN task_id INTEGER;
      ALTER TABLE messages ADD COLUMN provider TEXT;
      ALTER TABLE messages ADD COLUMN account_id INTEGER;
      ALTER TABLE messages ADD COLUMN model TEXT;
      ALTER TABLE messages ADD COLUMN effort TEXT;
      CREATE INDEX messages_task ON messages (task_id, id);
      ALTER TABLE runs ADD COLUMN task_id INTEGER;
      ALTER TABLE runs ADD COLUMN provider TEXT;
      ALTER TABLE runs ADD COLUMN account_id INTEGER;
      ALTER TABLE runs ADD COLUMN model TEXT;
      ALTER TABLE runs ADD COLUMN effort TEXT;
    `)
    chatsToTasks(db)
  },
  // v4: escolha de provedor/perfil/modelo/esforco por tarefa e ultima medida de contexto por sessao.
  db => db.exec(`
    ALTER TABLE tasks ADD COLUMN sel TEXT; -- JSON {provider, accountId, model, effort}; NULL = ainda nao escolhido
    CREATE TABLE metrics (
      task_id INTEGER NOT NULL, provider TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '',
      model TEXT, effort TEXT, occupied INTEGER, capacity INTEGER, estimated INTEGER NOT NULL DEFAULT 0,
      consumed_in INTEGER, consumed_out INTEGER, scope TEXT, source TEXT, at TEXT NOT NULL,
      PRIMARY KEY (task_id, provider, profile)
    );
  `),
  // v5: delegacoes (execucoes filhas) pedidas por um agente a outro provedor via ferramenta MCP local.
  db => db.exec(`
    CREATE TABLE delegations (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, parent_run_id INTEGER, provider TEXT NOT NULL, account_id INTEGER,
      model TEXT, effort TEXT, mode TEXT NOT NULL, objective TEXT NOT NULL, paths TEXT,
      status TEXT NOT NULL DEFAULT 'running', -- running | completed | failed | cancelled
      result TEXT, error TEXT, category TEXT, session_id TEXT, changed_files TEXT, out_of_scope TEXT, consumed TEXT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP, ended_at TEXT
    );
    CREATE INDEX delegations_task ON delegations (task_id, id);
  `),
  // v6: contabilidade de uso por execucao/delegacao. Campo que o provedor nao informou fica NULL (nunca 0). Um registro por
  // execucao/delegacao (indices unicos): pai e filhos sao processos separados, entao somar registros nao conta nada duas vezes.
  db => db.exec(`
    CREATE TABLE usage_records (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, run_id INTEGER, delegation_id INTEGER,
      provider TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '', model TEXT, effort TEXT, session_id TEXT,
      source TEXT, scope TEXT,                       -- scope: run | thread (o provedor informou acumulado do thread, ja convertido em delta)
      input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
      reasoning_included INTEGER, cache_read_included INTEGER, -- 1 = ja dentro de output/input; 0 = separado; NULL = desconhecido
      raw TEXT,                                       -- JSON do valor bruto informado (util quando o provedor acumula)
      estimated INTEGER NOT NULL DEFAULT 0, note TEXT,
      prompt_chars INTEGER, context_chars INTEGER, result_chars INTEGER, calls INTEGER, retries INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX usage_run ON usage_records (run_id) WHERE run_id IS NOT NULL;
    CREATE UNIQUE INDEX usage_delegation ON usage_records (delegation_id) WHERE delegation_id IS NOT NULL;
    CREATE INDEX usage_task ON usage_records (task_id, id);
  `),
  // v7: memoria por tarefa, pacotes de contexto (consentimento), entregas e artefatos. Nada aqui cruza task_id.
  // lineage = quem pode ler por padrao: 'user' (itens do usuario: nenhum agente ate haver pacote aprovado), 'chat:<tarefa>:<provedor>:<perfil>'
  // (execucao do usuario) ou 'del:<delegacao raiz>' (filho). Itens de agente ficam privados a linhagem ate um pacote aprovado.
  db => db.exec(`
    CREATE TABLE artifacts (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, run_id INTEGER, delegation_id INTEGER,
      producer TEXT NOT NULL, readers TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL, title TEXT,
      content TEXT NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL, scope TEXT, meta TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX artifacts_task ON artifacts (task_id, id);
    CREATE TABLE memory_items (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, owner TEXT NOT NULL, origin_id INTEGER, lineage TEXT NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, paths TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1, hash TEXT NOT NULL, norm TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active', -- active | stale | superseded
      todo_state TEXT, deps TEXT NOT NULL DEFAULT '[]', conflict_with INTEGER, supersedes INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX memory_task ON memory_items (task_id, kind, id);
    CREATE TABLE context_packages (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, source TEXT NOT NULL, -- delegation | history | memory
      issuer TEXT NOT NULL, recipient TEXT NOT NULL, provider TEXT NOT NULL, profile TEXT NOT NULL DEFAULT '', model TEXT, effort TEXT,
      workspace TEXT, scope TEXT NOT NULL DEFAULT '[]', items TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired | cancelled
      delegation_id INTEGER, parent_run_id INTEGER, session_id TEXT, reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT
    );
    CREATE INDEX packages_task ON context_packages (task_id, id);
    CREATE TABLE context_deliveries (
      id INTEGER PRIMARY KEY, package_id INTEGER NOT NULL, recipient TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
      revisions TEXT NOT NULL, -- JSON {itemId: revisao} enviados
      result TEXT NOT NULL DEFAULT 'sent', -- sent (enviado, resultado incerto) | confirmed | failed
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX deliveries_package ON context_deliveries (package_id);
    CREATE UNIQUE INDEX deliveries_confirmed ON context_deliveries (package_id, session_id) WHERE result='confirmed';
    ALTER TABLE delegations ADD COLUMN package_id INTEGER;
    ALTER TABLE delegations ADD COLUMN continuation_of INTEGER;
    ALTER TABLE delegations ADD COLUMN workspace TEXT;
    ALTER TABLE delegations ADD COLUMN artifact_id INTEGER;
    ALTER TABLE delegations ADD COLUMN lineage TEXT;
    ALTER TABLE messages ADD COLUMN clean TEXT; -- resposta sem marcadores de ferramenta nem avisos: e o que a transferencia de contexto usa
  `),
  // v8: permissoes dos agentes. Regras "sempre permitir/negar" por agente (provedor), tipo (bash | tool) e padrao (comando exato ou
  // prefixo "npm run *"); pedidos de permissao com estado (pendente, permitido uma vez/por regra/sempre, negado, expirado).
  db => db.exec(`
    CREATE TABLE permission_rules (
      id INTEGER PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL, pattern TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'allow', risk TEXT NOT NULL DEFAULT 'low', acknowledged INTEGER NOT NULL DEFAULT 0,
      project TEXT NOT NULL DEFAULT '', -- '' = todos os projetos; senao a pasta do projeto
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX permission_rules_uq ON permission_rules (provider, kind, pattern, project);
    CREATE TABLE permission_requests (
      id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, delegation_id INTEGER, provider TEXT NOT NULL,
      tool TEXT NOT NULL, kind TEXT NOT NULL, command TEXT, summary TEXT, cwd TEXT,
      state TEXT NOT NULL DEFAULT 'pending', -- pending | allowed_once | allowed_always | allowed_rule | denied | denied_rule | expired
      rule_id INTEGER, risk TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, decided_at TEXT
    );
    CREATE INDEX permission_requests_state ON permission_requests (state, id);
  `),
  // v9: identidade EFETIVA de execucao (grant), criada pelo backend: tarefa + destinatario (provedor, perfil, modelo, esforco, area, escopo) + sessao
  // nativa (vinculada quando o executor a informa). E o que autoriza LER memoria propria e artefatos, alem dos pacotes aprovados (que
  // continuam validados por estado, hash e destinatario). Itens/artefatos legados nao tem grant: exigem novo pedido, nada e apagado.
  db => db.exec(`
    CREATE TABLE exec_grants (
      auth_id TEXT PRIMARY KEY, task_id INTEGER NOT NULL, lineage TEXT NOT NULL, recipient_hash TEXT NOT NULL, session_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX exec_grants_lookup ON exec_grants (task_id, recipient_hash, session_id);
    ALTER TABLE memory_items ADD COLUMN grant_id TEXT;
  `),
  // v10: o contador "calls" sempre foi alimentado pela quantidade de FERRAMENTAS que a CLI informou, nunca por chamadas ao modelo (que nenhuma CLI
  // informa de forma comparavel). O nome passa a dizer isso; valores preservados, NULL continua "nao informado".
  db => db.exec('ALTER TABLE usage_records RENAME COLUMN calls TO tool_calls;'),
  // v11: mensagens do usuario retidas ate a decisao sobre o contexto que dependem (transferencia entre provedores/sessoes). Nada roda antes da decisao;
  // o indice unico parcial reserva a tarefa contra envio duplicado. Cancelar, expirar (tempo/reinicio) ou mudar de destino nunca inicia a CLI e
  // a mensagem continua recuperavel. `sel` e o destino que o usuario escolheu ao enviar: a decisao executa nele, nunca no que estiver na tela depois.
  db => db.exec(`
    CREATE TABLE pending_sends (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, package_id INTEGER, text TEXT NOT NULL, sel TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'awaiting_context_approval', -- awaiting_context_approval | starting | sent | cancelled | expired
      decision TEXT, reason TEXT, dismissed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT
    );
    CREATE INDEX pending_sends_task ON pending_sends (task_id, id);
    CREATE UNIQUE INDEX pending_sends_one ON pending_sends (task_id) WHERE state='awaiting_context_approval';
  `),
  // v12: o que NAO coube num pacote candidato (limite de itens/caracteres, item grande demais, desatualizado). E so informacao para o usuario ajustar
  // os limites ou escolher outra selecao: nao entra no hash e nunca e enviado ao destinatario.
  db => db.exec('ALTER TABLE context_packages ADD COLUMN omitted TEXT;'),
  // v13: falas do agente separadas (JSON), so quando a CLI nao marcou a resposta final e houve mais de uma. `clean` continua sendo o texto integral
  // (auditoria); a transferencia de contexto usa as falas para manter as ULTIMAS (onde fica a resposta) quando o conjunto passa do limite por mensagem.
  db => db.exec('ALTER TABLE messages ADD COLUMN clean_parts TEXT;'),
  // v14: aprovacao PARCIAL (o usuario desmarca itens). O pacote exibido nunca e editado: o subconjunto vira um pacote novo (hash proprio) e o
  // original fica cancelado apontando para ele, para a delegacao que espera e a mensagem retida seguirem com o que foi aprovado.
  db => db.exec('ALTER TABLE context_packages ADD COLUMN replaced_by INTEGER;'),
  // v15: etapas de trabalho por tarefa. Aceite humano separado do término da execução.
  db => db.exec(`
    CREATE TABLE task_steps (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, position INTEGER NOT NULL,
      title TEXT NOT NULL, instruction TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      run_id INTEGER, send_id INTEGER, error TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(task_id, position)
    );
    CREATE UNIQUE INDEX steps_active ON task_steps(task_id) WHERE state IN ('starting','awaiting_context','running');
  `),
  // v16: histórico observável de testes, builds e execução local; comandos não chamam IA.
  db => db.exec(`
    CREATE TABLE command_runs (
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, workspace TEXT NOT NULL,
      name TEXT NOT NULL, program TEXT NOT NULL, args TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running', output TEXT NOT NULL DEFAULT '', truncated INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER, duration_ms INTEGER, error TEXT,
      started_at TEXT DEFAULT CURRENT_TIMESTAMP, ended_at TEXT
    );
    CREATE INDEX command_runs_task ON command_runs(task_id,id);
  `),
  // v17: catálogo de assets; cada revisão aponta para uma cópia imutável fora do projeto.
  db => db.exec(`
    CREATE TABLE project_assets (
      id INTEGER PRIMARY KEY, game TEXT NOT NULL, title TEXT NOT NULL, path TEXT NOT NULL,
      kind TEXT NOT NULL, license TEXT NOT NULL, source TEXT NOT NULL, tags TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(game,path)
    );
    CREATE TABLE asset_versions (
      id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL,
      file_name TEXT NOT NULL, note TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT,
      UNIQUE(asset_id,hash)
    );
    CREATE INDEX asset_versions_asset ON asset_versions(asset_id,id);
  `),
  // v18: observações humanas e screenshots de playtests; sem alimentar agentes automaticamente.
  db => db.exec(`
    CREATE TABLE project_playtests (
      id INTEGER PRIMARY KEY, game TEXT NOT NULL, title TEXT NOT NULL, scenario TEXT NOT NULL,
      expected TEXT NOT NULL, observed TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('pass','fail','mixed')),
      notes TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('low','medium','high')),
      images TEXT NOT NULL DEFAULT '[]',
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','resolved')),
      pin_id INTEGER, build_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX playtests_game ON project_playtests(game,id);
  `),
  // v19: arquivo distribuível e comando de origem preservados após excluir a tarefa.
  db => db.exec(`
    CREATE TABLE project_builds (
      id INTEGER PRIMARY KEY, game TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
      platform TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, file_name TEXT NOT NULL,
      notes TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected')),
      source_task_id INTEGER, source_command_id INTEGER, command TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT
    );
    CREATE INDEX builds_game ON project_builds(game,id);
  `)
]

const PIN_TASK_STATE: Record<string, string> = { aberto: 'aberta', andamento: 'andamento', feito: 'concluida' }
const one = (db: DatabaseSync, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as any

// Cada pin vira uma tarefa (mesmo estado, branch e worktree). Cada chat geral (pasta+agente+conta) vira UMA tarefa
// legada propria: contextos que eram independentes nao sao fundidos. Falha (e desfaz tudo) se sobrar mensagem sem tarefa.
function chatsToTasks(db: DatabaseSync) {
  const total = one(db, 'SELECT COUNT(*) n FROM messages').n
  const pinTask = new Map<number, number>()
  for (const p of db.prepare('SELECT * FROM pins ORDER BY id').all() as any[]) {
    const id = Number(db.prepare(
      "INSERT INTO tasks (game, title, state, legacy, pin_id, branch, worktree, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).run(p.game, p.title, PIN_TASK_STATE[p.status] ?? 'aberta', 'pin', p.id, p.branch, p.worktree, p.created_at, p.created_at).lastInsertRowid)
    pinTask.set(p.id, id)
  }
  const keys = db.prepare('SELECT chat_key k FROM messages UNION SELECT key FROM chats').all() as any[]
  for (const { k } of keys) {
    const parts = k.split('|') // "<escopo>|<agente>|<conta>"; o escopo (pasta) nao contem '|' no Windows
    const acc = parts.pop() ?? ''
    const agent = parts.pop() || 'desconhecido'
    const scope = parts.join('|')
    const accountId = acc && Number.isFinite(Number(acc)) ? Number(acc) : null
    const last = one(db, 'SELECT MAX(created_at) t FROM messages WHERE chat_key=?', k).t
    let taskId: number | undefined
    if (scope.startsWith('pin:')) {
      const pinId = Number(scope.slice(4))
      taskId = pinTask.get(pinId)
      if (!taskId) { // pin ja removido: o historico continua acessivel como tarefa legada
        taskId = Number(db.prepare("INSERT INTO tasks (game, title, state, legacy, updated_at) VALUES ('', ?, 'concluida', 'chat', ?)")
          .run(`Problema removido #${pinId}`, last).lastInsertRowid)
        pinTask.set(pinId, taskId)
      }
    } else {
      const name = accountId ? one(db, 'SELECT name FROM accounts WHERE id=?', accountId)?.name : null
      taskId = Number(db.prepare("INSERT INTO tasks (game, title, state, legacy, updated_at) VALUES (?,?,'aberta','chat',COALESCE(?, CURRENT_TIMESTAMP))")
        .run(scope.replace(/^game:/, ''), `Chat legado: ${agent}${name ? ` (${name})` : ''}`, last).lastInsertRowid)
    }
    db.prepare('UPDATE messages SET task_id=?, provider=?, account_id=? WHERE chat_key=?').run(taskId, agent, accountId, k)
    db.prepare('UPDATE runs SET task_id=?, provider=?, account_id=? WHERE chat_key=?').run(taskId, agent, accountId, k)
    const s = one(db, 'SELECT session_id FROM chats WHERE key=?', k)
    if (s?.session_id) db.prepare('INSERT OR IGNORE INTO task_sessions (task_id, provider, profile, session_id) VALUES (?,?,?,?)').run(taskId, agent, acc, s.session_id)
    db.prepare('UPDATE tasks SET updated_at = MAX(updated_at, COALESCE(?, updated_at)) WHERE id=?').run(last, taskId)
  }
  const orphan = one(db, 'SELECT COUNT(*) n FROM messages WHERE task_id IS NULL').n
  const after = one(db, 'SELECT COUNT(*) n FROM messages WHERE task_id IS NOT NULL').n
  if (orphan || after !== total) throw new Error(`Migracao de tarefas abortada: ${orphan} mensagem(ns) sem tarefa (${after}/${total}).`)
}

// Aplica as migracoes pendentes, cada uma em transacao. Antes de mexer num banco existente faz uma copia
// consistente (VACUUM INTO). Banco de versao futura: recusa sem tocar nos dados.
export function migrate(db: DatabaseSync, backupPrefix?: string) {
  const cur = (db.prepare('PRAGMA user_version').get() as any).user_version as number
  if (cur > MIGRATIONS.length) throw new Error(`Banco na versao ${cur}, mais nova que esta do app (${MIGRATIONS.length}). Nada foi alterado.`)
  if (cur === MIGRATIONS.length) return
  const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get()
  if (backupPrefix && existing) {
    const file = `${backupPrefix}.v${cur}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  }
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      MIGRATIONS[v](db)
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
}

export function openDb(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  migrate(db, file)
  return db
}
