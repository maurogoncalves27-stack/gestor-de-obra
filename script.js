const STORAGE_KEY = "estoque-cotacao-v1";
const SESSION_KEY = "estoque-cotacao-session";
const CLOUD_KEY = "estoque-cotacao-cloud";
const ENVIO_SIG_KEY = "estoque-cotacao-envio-sigs";

const DEFAULT_LOJAS = [
  { id: "central", nome: "Estoque Central", ativo: true },
  { id: "lago-sul", nome: "Lago Sul", ativo: true },
  { id: "aguas-claras", nome: "Águas Claras", ativo: true },
  { id: "asa-norte", nome: "Asa Norte", ativo: true },
  { id: "asa-sul", nome: "Asa Sul", ativo: true },
  { id: "fabrica", nome: "Fábrica", ativo: true },
];

const DEFAULT_FORNECEDORES = [
  { id: "amorix", nome: "Amorix", ativo: true, contato: "" },
  { id: "oesa", nome: "Oesa", ativo: true, contato: "" },
  { id: "garra", nome: "Garra", ativo: true, contato: "" },
  { id: "rei-nosso", nome: "Rei Nosso", ativo: true, contato: "" },
  { id: "personalizados", nome: "Personalizados", ativo: true, contato: "" },
  { id: "ceasa", nome: "Ceasa", ativo: true, contato: "" },
];

const VIEW_META = {
  dashboard: ["Dashboard", "Resumo operacional"],
  contagem: ["Contagem", "Contar estoque da loja (domingo / mobile)"],
  estoque: ["Estoque", "Saldo por loja"],
  "envio-sexta": ["Envio", "Listagem de envio por loja"],
  emergencia: ["Emergência", "Pedidos urgentes entre lojas e o Central"],
  producao: ["Produção", "Lista da fábrica"],
  cotacao: ["Cotação", "Preços por fornecedor"],
  resultado: ["Resultado", "Comparativo e vencedores"],
  pedidos: ["Pedidos", "Pedidos emitidos aos fornecedores"],
  valores: ["Valores", "Estoque valorizado pelas cotações"],
  configuracoes: ["Configurações", "Usuários, fornecedores, cotação e nuvem"],
};

const PEDIDO_STATUS = {
  rascunho: "Rascunho",
  emitido: "Emitido",
  visto: "Visto",
};

const DIAS_COTACAO = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

const EMERGENCIA_STATUS = {
  pendente: "Pendente",
  enviada: "Enviada",
  atendida: "Atendida",
  cancelada: "Cancelada",
};

let envioSigPads = null;
let envioChecklist = {};
let envioSigRestoredKey = "";
/** Categorias abertas na sanfona da Cotação (persiste entre re-renders). */
const cotacaoAccOpen = new Set();

let state = null;
let session = null;
let saveTimer = null;
let seedCache = null;
let supabaseClient = null;
let cloudChannel = null;
let applyingRemote = false;
let lastCloudUpdatedAt = null;

function uid() {
  return crypto.randomUUID();
}

function slugify(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || `f-${Date.now().toString(36)}`;
}

function getLojas() {
  return (state?.lojas || DEFAULT_LOJAS).filter((l) => l.ativo !== false);
}

function getAllLojas() {
  return state?.lojas || DEFAULT_LOJAS;
}

function getFornecedores() {
  return (state?.fornecedores || DEFAULT_FORNECEDORES).filter((f) => f.ativo !== false);
}

function getAllFornecedores() {
  return state?.fornecedores || DEFAULT_FORNECEDORES;
}

function defaultUsers() {
  const users = [
    { id: "admin", nome: "Administração", role: "admin", password: "Senha@123", lojaId: "", fornecedorId: "" },
  ];
  const lojaPass = {
    central: "central123",
    "lago-sul": "lago123",
    "aguas-claras": "aguas123",
    "asa-norte": "norte123",
    "asa-sul": "sul123",
    fabrica: "fabrica123",
  };
  DEFAULT_LOJAS.forEach((l) => {
    users.push({
      id: l.id,
      nome: l.nome,
      role: "loja",
      password: lojaPass[l.id] || `${l.id}123`,
      lojaId: l.id,
      fornecedorId: "",
    });
  });
  const fornPass = {
    amorix: "amorix123",
    oesa: "oesa123",
    garra: "garra123",
    "rei-nosso": "rei123",
    personalizados: "perso123",
    ceasa: "ceasa123",
  };
  DEFAULT_FORNECEDORES.forEach((f) => {
    users.push({
      id: f.id,
      nome: f.nome,
      role: "fornecedor",
      password: fornPass[f.id] || `${f.id}123`,
      lojaId: "",
      fornecedorId: f.id,
    });
  });
  return users;
}

function emptyEstoqueEntry() {
  return {
    saldo: 0,
    minimo: 0,
    envio: 0,
    lotes: [],
    okEntregador: false,
    okLoja: false,
    minimoAuto: false,
    minimoManual: false,
  };
}

function normalizeValidadeISO(raw) {
  if (!raw) return "";
  const s = String(raw).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function emptyLote(partial = {}) {
  return {
    id: partial.id || uid(),
    codigo: partial.codigo != null ? String(partial.codigo) : "",
    qtde: Number(partial.qtde) || 0,
    validade: normalizeValidadeISO(partial.validade) || "",
  };
}

/** Migra validade1/2/3 legadas → lotes e normaliza o array. Remove campos antigos. */
function migrateValidadesToLotes(entry) {
  if (!entry || typeof entry !== "object") return entry;
  if (!Array.isArray(entry.lotes)) entry.lotes = [];

  const legacyDates = [1, 2, 3]
    .map((n) => ({ n, data: normalizeValidadeISO(entry[`validade${n}`]) }))
    .filter((x) => x.data);

  if (legacyDates.length && entry.lotes.length === 0) {
    legacyDates.forEach(({ n, data }) => {
      entry.lotes.push(emptyLote({ codigo: `Lote ${n}`, qtde: 0, validade: data }));
    });
  }

  delete entry.validade1;
  delete entry.validade2;
  delete entry.validade3;

  entry.lotes = entry.lotes
    .filter((l) => l && typeof l === "object")
    .map((l) => emptyLote(l));

  return entry;
}

function somaQtdeLotes(entry) {
  return (entry?.lotes || []).reduce((s, l) => s + (Number(l.qtde) || 0), 0);
}

/** Log simples de movimentações de saldo (ajuste, contagem, envio, emergência, produção…). */
function pushMovimento({ lojaId, produtoId, de, para, motivo, nota = "", tipo = "" } = {}) {
  if (!state) return;
  if (!Array.isArray(state.movimentos)) state.movimentos = [];
  const deN = Number(de) || 0;
  const paraN = Number(para) || 0;
  if (deN === paraN && motivo !== "contagem") return;
  state.movimentos.unshift({
    id: uid(),
    lojaId: lojaId || "",
    produtoId: produtoId || "",
    de: deN,
    para: paraN,
    motivo: motivo || "ajuste",
    nota: String(nota || "").slice(0, 240),
    tipo: tipo || motivo || "ajuste",
    em: new Date().toISOString(),
    por: session?.userId || "",
  });
  if (state.movimentos.length > 2000) state.movimentos.length = 2000;
}

function listLotesMismatch(lojaId) {
  const list = [];
  produtosDaLoja(lojaId, { incluirOcultos: true }).forEach((p) => {
    const e = ensureEstoque(lojaId, p.id);
    migrateValidadesToLotes(e);
    const nLotes = (e.lotes || []).length;
    if (!nLotes) return;
    const soma = somaQtdeLotes(e);
    const saldo = Number(e.saldo) || 0;
    if (Math.abs(soma - saldo) > 1e-6) {
      list.push({ produtoId: p.id, nome: p.nome, saldo, soma, delta: Math.round((soma - saldo) * 1000) / 1000 });
    }
  });
  return list;
}

function igualarSaldoAosLotes(lojaId, produtoId, { silent = false } = {}) {
  const entry = ensureEstoque(lojaId, produtoId);
  migrateValidadesToLotes(entry);
  const soma = somaQtdeLotes(entry);
  const de = Number(entry.saldo) || 0;
  if (Math.abs(soma - de) < 1e-6) {
    if (!silent) alert("Saldo já confere com a soma dos lotes.");
    return false;
  }
  entry.saldo = Math.round(soma * 1000) / 1000;
  pushMovimento({
    lojaId,
    produtoId,
    de,
    para: entry.saldo,
    motivo: "correcao",
    nota: "Igualar saldo à soma dos lotes",
    tipo: "ajuste",
  });
  return true;
}

function igualarSaldosMismatch(lojaId) {
  const mismatches = listLotesMismatch(lojaId);
  if (!mismatches.length) {
    alert("Nenhum produto com soma de lotes diferente do saldo.");
    return;
  }
  if (
    !confirm(
      `Igualar saldo à soma dos lotes em ${mismatches.length} produto(s)?\n` +
        mismatches
          .slice(0, 8)
          .map((x) => `• ${x.nome}: ${formatNum(x.saldo)} → ${formatNum(x.soma)}`)
          .join("\n") +
        (mismatches.length > 8 ? `\n… +${mismatches.length - 8} mais` : "")
    )
  ) {
    return;
  }
  mismatches.forEach((x) => igualarSaldoAosLotes(lojaId, x.produtoId, { silent: true }));
  scheduleSave();
  renderEstoque();
}

const MOTIVOS_SALDO = [
  { id: "ajuste", label: "Ajuste" },
  { id: "quebra", label: "Quebra" },
  { id: "correcao", label: "Correção" },
  { id: "outro", label: "Outro" },
];

function openSaldoMotivoModal({ lojaId, produtoId, de, para }, onConfirm) {
  const p = getProduto(produtoId);
  const modal = document.getElementById("modal");
  const saveBtn = document.getElementById("modal-save");
  const cancelBtn = document.getElementById("modal-cancel");
  document.getElementById("modal-title").textContent = "Motivo da alteração de saldo";
  document.getElementById("modal-body").innerHTML = `
    <p class="toolbar-hint">
      <strong>${esc(p?.nome || produtoId)}</strong> · ${esc(lojaNome(lojaId))}<br />
      ${formatNum(de)} → <strong>${formatNum(para)}</strong> ${esc(p?.unidade || "")}
    </p>
    <label class="field"><span>Motivo</span>
      <select id="saldo-motivo" required>
        ${MOTIVOS_SALDO.map((m) => `<option value="${m.id}">${m.label}</option>`).join("")}
      </select>
    </label>
    <label class="field"><span>Nota (opcional)</span>
      <input id="saldo-nota" type="text" maxlength="240" placeholder="Ex.: inventário parcial, dano…" />
    </label>`;
  if (saveBtn) {
    saveBtn.classList.remove("hidden");
    saveBtn.textContent = "Confirmar";
  }
  if (cancelBtn) cancelBtn.textContent = "Cancelar";
  modal.showModal();
  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    const motivo = document.getElementById("saldo-motivo")?.value || "ajuste";
    const nota = (document.getElementById("saldo-nota")?.value || "").trim();
    modal.close();
    onConfirm({ motivo, nota });
  };
  const onClose = () => {
    if (saveBtn) saveBtn.textContent = "Salvar";
    if (cancelBtn) cancelBtn.textContent = "Cancelar";
    modal.removeEventListener("close", onClose);
  };
  modal.addEventListener("close", onClose);
}

function setSaldoComMotivo(lojaId, produtoId, novoSaldo, { motivo, nota = "", tipo = "" } = {}) {
  const entry = ensureEstoque(lojaId, produtoId);
  const de = Number(entry.saldo) || 0;
  const para = Math.max(0, Number(novoSaldo) || 0);
  entry.saldo = para;
  pushMovimento({ lojaId, produtoId, de, para, motivo: motivo || "ajuste", nota, tipo: tipo || motivo });
  return entry;
}

function emptyCotacaoEntry() {
  return { qtde: 0, preco: 0, observacoes: "", status: "FALTA" };
}

function defaultCotacaoAgenda() {
  return {
    modo: "livre",
    inicioDia: 0,
    inicioHora: "08:00",
    fimDia: 1,
    fimHora: "18:00",
  };
}

function normalizeHoraCotacao(hhmm, fallback = "08:00") {
  const m = String(hhmm || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const h = Math.min(23, Math.max(0, Number(m[1])));
  const min = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function normalizeCotacaoAgenda(raw) {
  const base = defaultCotacaoAgenda();
  const a = raw && typeof raw === "object" ? raw : {};
  const modo = ["auto", "livre", "travada"].includes(a.modo) ? a.modo : base.modo;
  const inicioDia = Math.min(6, Math.max(0, Number(a.inicioDia)));
  const fimDia = Math.min(6, Math.max(0, Number(a.fimDia)));
  return {
    modo,
    inicioDia: Number.isFinite(inicioDia) ? inicioDia : base.inicioDia,
    inicioHora: normalizeHoraCotacao(a.inicioHora, base.inicioHora),
    fimDia: Number.isFinite(fimDia) ? fimDia : base.fimDia,
    fimHora: normalizeHoraCotacao(a.fimHora, base.fimHora),
  };
}

function ensureCotacaoAgenda() {
  if (!state) return defaultCotacaoAgenda();
  state.cotacaoAgenda = normalizeCotacaoAgenda(state.cotacaoAgenda);
  return state.cotacaoAgenda;
}

function parseHoraToMinutes(hhmm) {
  const norm = normalizeHoraCotacao(hhmm, "00:00");
  const [h, m] = norm.split(":").map(Number);
  return h * 60 + m;
}

function weekMinutesFrom(dia, hora) {
  return Number(dia) * 24 * 60 + parseHoraToMinutes(hora);
}

function nowWeekMinutes(date = new Date()) {
  return date.getDay() * 24 * 60 + date.getHours() * 60 + date.getMinutes();
}

/** Janela semanal; se início > fim, cruza meia-noite / virada da semana. */
function cotacaoJanelaContem(nowM, startM, endM) {
  if (startM === endM) return true;
  if (startM < endM) return nowM >= startM && nowM < endM;
  return nowM >= startM || nowM < endM;
}

function cotacaoEstaLiberada(date = new Date()) {
  const a = ensureCotacaoAgenda();
  if (a.modo === "livre") return true;
  if (a.modo === "travada") return false;
  return cotacaoJanelaContem(
    nowWeekMinutes(date),
    weekMinutesFrom(a.inicioDia, a.inicioHora),
    weekMinutesFrom(a.fimDia, a.fimHora)
  );
}

function formatDiaHoraCotacao(dia, hora) {
  return `${DIAS_COTACAO[Number(dia) % 7] || "Dom"} ${normalizeHoraCotacao(hora)}`;
}

function labelStatusCotacaoAgenda(date = new Date()) {
  const a = ensureCotacaoAgenda();
  const liberada = cotacaoEstaLiberada(date);
  if (a.modo === "livre") {
    return { liberada: true, banner: "", badge: "Liberada (manual)", detalhe: "Modo manual — sempre liberada" };
  }
  if (a.modo === "travada") {
    return {
      liberada: false,
      banner: "Cotação travada pelo administrador",
      badge: "Travada (manual)",
      detalhe: "Modo manual — sempre travada para fornecedores",
    };
  }
  const ateInicio = formatDiaHoraCotacao(a.inicioDia, a.inicioHora);
  const ateFim = formatDiaHoraCotacao(a.fimDia, a.fimHora);
  if (liberada) {
    return {
      liberada: true,
      banner: "",
      badge: `Aberta até ${ateFim}`,
      detalhe: `Automático — aberta até ${ateFim}`,
    };
  }
  return {
    liberada: false,
    banner: `Cotação travada até ${ateInicio}`,
    badge: `Travada até ${ateInicio}`,
    detalhe: `Automático — libera em ${ateInicio}`,
  };
}

function opcoesDiaCotacao(selected) {
  return DIAS_COTACAO.map(
    (nome, i) => `<option value="${i}" ${Number(selected) === i ? "selected" : ""}>${nome}</option>`
  ).join("");
}

function emptyProducaoEntry() {
  return {
    lista: "",
    totalProduzir: 0,
    qtdeBaldes: 0,
    totalProduzido: 0,
    producaoAplicadaEm: "",
    concluidoAt: "",
    concluidoQtde: 0,
  };
}

function defaultState(seed) {
  const produtos = seed?.produtos || [];
  const lojas = DEFAULT_LOJAS.map((l) => ({ ...l }));
  const fornecedores = DEFAULT_FORNECEDORES.map((f) => ({ ...f }));
  const estoques = {};
  lojas.forEach((l) => {
    estoques[l.id] = {};
    produtos.forEach((p) => {
      const fromSeed = seed?.estoques?.[l.id]?.[p.id];
      estoques[l.id][p.id] = fromSeed ? { ...emptyEstoqueEntry(), ...fromSeed } : emptyEstoqueEntry();
    });
  });
  const cotacoes = {};
  fornecedores.forEach((f) => {
    cotacoes[f.id] = {};
    produtos.forEach((p) => {
      const fromSeed = seed?.cotacoes?.[f.id]?.[p.id];
      cotacoes[f.id][p.id] = fromSeed ? { ...emptyCotacaoEntry(), ...fromSeed } : emptyCotacaoEntry();
    });
  });
  const producao = {};
  produtos.forEach((p) => {
    const fromSeed = seed?.producao?.[p.id];
    producao[p.id] = fromSeed ? { ...emptyProducaoEntry(), ...fromSeed } : emptyProducaoEntry();
  });

  return {
    seedVersion: seed?.seedVersion || "",
    usuarios: defaultUsers(),
    lojas,
    fornecedores,
    produtos,
    estoques,
    cotacoes,
    producao,
    receitasMinimoFabrica: seed?.receitasMinimoFabrica || {},
    producaoAuto: seed?.producaoAuto || {},
    baldesPor: seed?.baldesPor || {},
    produtosPorLoja: seed?.produtosPorLoja || {},
    solicitacoesEmergencia: [],
    historicoPrecos: [],
    enviosAplicados: {},
    movimentos: [],
    fornecedorItensOcultos: {},
    cotacaoAgenda: defaultCotacaoAgenda(),
    pedidosFornecedor: [],
  };
}

/** Atualiza produtos/estoque/cotação/produção a partir do seed, preservando usuários e pedidos. */
function applyOperationalFromSeed(data, seed) {
  const fresh = defaultState(seed);
  const usuarios = data.usuarios?.length ? data.usuarios : fresh.usuarios;
  const solicitacoesEmergencia = Array.isArray(data.solicitacoesEmergencia)
    ? data.solicitacoesEmergencia
    : [];
  const historicoPrecos = Array.isArray(data.historicoPrecos) ? data.historicoPrecos : [];
  const enviosAplicados =
    data.enviosAplicados && typeof data.enviosAplicados === "object" ? data.enviosAplicados : {};
  const movimentos = Array.isArray(data.movimentos) ? data.movimentos : [];
  const pedidosFornecedor = Array.isArray(data.pedidosFornecedor) ? data.pedidosFornecedor : [];
  const fornecedorItensOcultos =
    data.fornecedorItensOcultos && typeof data.fornecedorItensOcultos === "object"
      ? data.fornecedorItensOcultos
      : {};
  const cotacaoAgenda =
    data.cotacaoAgenda && typeof data.cotacaoAgenda === "object"
      ? data.cotacaoAgenda
      : fresh.cotacaoAgenda;
  const lojas = data.lojas?.length ? data.lojas : fresh.lojas;
  const fornecedores = data.fornecedores?.length ? data.fornecedores : fresh.fornecedores;

  data.produtos = fresh.produtos;
  data.estoques = fresh.estoques;
  data.cotacoes = fresh.cotacoes;
  data.producao = fresh.producao;
  data.receitasMinimoFabrica = fresh.receitasMinimoFabrica;
  data.producaoAuto = fresh.producaoAuto;
  data.baldesPor = fresh.baldesPor;
  data.produtosPorLoja = fresh.produtosPorLoja;
  data.usuarios = usuarios;
  data.lojas = lojas;
  data.fornecedores = fornecedores;
  data.solicitacoesEmergencia = solicitacoesEmergencia;
  data.historicoPrecos = historicoPrecos;
  data.enviosAplicados = enviosAplicados;
  data.movimentos = movimentos;
  data.pedidosFornecedor = pedidosFornecedor;
  data.fornecedorItensOcultos = fornecedorItensOcultos;
  data.cotacaoAgenda = cotacaoAgenda;
  data.seedVersion = seed?.seedVersion || "";
  return migrateState(data);
}

function migrateState(data) {
  if (!data.lojas?.length) data.lojas = DEFAULT_LOJAS.map((l) => ({ ...l }));
  if (!data.lojas.find((l) => l.id === "fabrica")) {
    data.lojas.push({ id: "fabrica", nome: "Fábrica", ativo: true });
  }
  if (!data.fornecedores?.length) data.fornecedores = DEFAULT_FORNECEDORES.map((f) => ({ ...f }));
  // Inclui novos fornecedores padrão (ex.: Ceasa) sem apagar os cadastrados
  DEFAULT_FORNECEDORES.forEach((def) => {
    if (!data.fornecedores.find((f) => f.id === def.id)) {
      data.fornecedores.push({ ...def });
    }
  });
  if (!data.usuarios?.length) data.usuarios = defaultUsers();
  if (!data.usuarios.find((u) => u.id === "fabrica" && u.role === "loja")) {
    data.usuarios.push({
      id: "fabrica",
      nome: "Fábrica",
      role: "loja",
      password: "fabrica123",
      lojaId: "fabrica",
      fornecedorId: "",
    });
  }
  if (!data.estoques) data.estoques = {};
  if (!data.cotacoes) data.cotacoes = {};
  if (!data.producao) data.producao = {};
  if (!data.receitasMinimoFabrica) data.receitasMinimoFabrica = {};
  if (!data.producaoAuto) data.producaoAuto = {};
  if (!data.baldesPor) data.baldesPor = {};
  if (!data.produtosPorLoja || typeof data.produtosPorLoja !== "object") data.produtosPorLoja = {};
  if (!Array.isArray(data.solicitacoesEmergencia)) data.solicitacoesEmergencia = [];
  if (!Array.isArray(data.historicoPrecos)) data.historicoPrecos = [];
  if (!data.enviosAplicados || typeof data.enviosAplicados !== "object") data.enviosAplicados = {};
  if (!Array.isArray(data.movimentos)) data.movimentos = [];
  if (!Array.isArray(data.pedidosFornecedor)) data.pedidosFornecedor = [];
  if (!data.producoesAplicadas || typeof data.producoesAplicadas !== "object") data.producoesAplicadas = {};
  if (!data.fornecedorItensOcultos || typeof data.fornecedorItensOcultos !== "object") {
    data.fornecedorItensOcultos = {};
  } else {
    Object.keys(data.fornecedorItensOcultos).forEach((fid) => {
      if (!Array.isArray(data.fornecedorItensOcultos[fid])) data.fornecedorItensOcultos[fid] = [];
    });
  }
  data.cotacaoAgenda = normalizeCotacaoAgenda(data.cotacaoAgenda);
  // Garante mapa de itens visíveis vindo do seed (filtro da planilha)
  if (seedCache?.produtosPorLoja) {
    Object.entries(seedCache.produtosPorLoja).forEach(([lid, ids]) => {
      if (!data.produtosPorLoja[lid]?.length && Array.isArray(ids) && ids.length) {
        data.produtosPorLoja[lid] = [...ids];
      }
    });
  }
  data.lojas.forEach((l) => {
    if (!data.estoques[l.id]) data.estoques[l.id] = {};
  });
  Object.values(data.estoques).forEach((lojaMap) => {
    Object.values(lojaMap || {}).forEach((e) => migrateValidadesToLotes(e));
  });
  (data.produtos || []).forEach((p) => {
    if (p && p.sku == null) p.sku = "";
  });
  // Remove cadastro inválido "diferença tampas" (id 310 — não é produto)
  const dropIds = new Set(
    (data.produtos || [])
      .filter((p) => {
        if (!p) return false;
        if (p.id === "310") return true;
        const blob = `${p.nome || ""} ${p.unidade || ""}`.toLowerCase();
        return blob.includes("diferença tampas") || blob.includes("diferenca tampas");
      })
      .map((p) => p.id)
  );
  if (dropIds.size) {
    data.produtos = (data.produtos || []).filter((p) => !dropIds.has(p.id));
    Object.values(data.estoques || {}).forEach((lojaMap) => {
      if (!lojaMap) return;
      dropIds.forEach((id) => delete lojaMap[id]);
    });
    Object.values(data.cotacoes || {}).forEach((fmap) => {
      if (!fmap) return;
      dropIds.forEach((id) => delete fmap[id]);
    });
    Object.keys(data.produtosPorLoja || {}).forEach((lid) => {
      const ids = data.produtosPorLoja[lid];
      if (Array.isArray(ids)) data.produtosPorLoja[lid] = ids.filter((id) => !dropIds.has(id));
    });
    ["producao", "receitasMinimoFabrica", "producaoAuto", "baldesPor"].forEach((k) => {
      if (!data[k]) return;
      dropIds.forEach((id) => delete data[k][id]);
    });
  }
  data.fornecedores.forEach((f) => {
    if (!data.cotacoes[f.id]) data.cotacoes[f.id] = {};
    if (!data.usuarios.find((u) => u.id === f.id && u.role === "fornecedor")) {
      data.usuarios.push({
        id: f.id,
        nome: f.nome,
        role: "fornecedor",
        password: `${f.id}123`.slice(0, 20),
        lojaId: "",
        fornecedorId: f.id,
      });
    }
  });
  // Migra senha padrão antiga do admin (admin123 → Senha@123)
  const admin = data.usuarios.find((u) => u.id === "admin" && u.role === "admin");
  if (admin && admin.password === "admin123") admin.password = "Senha@123";
  return data;
}

function countSaldoPositivo(estoques) {
  let n = 0;
  Object.values(estoques || {}).forEach((loja) => {
    Object.values(loja || {}).forEach((e) => {
      if (Number(e?.saldo) > 0) n += 1;
    });
  });
  return n;
}

async function loadSeed() {
  if (seedCache) return seedCache;
  // Preferência: seed embutido (funciona no Chrome com file:// — fetch local falha)
  if (window.SEED_DATA?.produtos?.length) {
    seedCache = window.SEED_DATA;
    return seedCache;
  }
  try {
    const res = await fetch("seed-data.json");
    if (!res.ok) throw new Error("seed missing");
    seedCache = await res.json();
    return seedCache;
  } catch {
    seedCache = {
      produtos: [],
      estoques: {},
      cotacoes: {},
      producao: {},
      receitasMinimoFabrica: {},
      producaoAuto: {},
      baldesPor: {},
    };
    return seedCache;
  }
}

async function loadState() {
  const seed = await loadSeed();
  const seedVer = seed?.seedVersion || "";
  const seedHasStock = countSaldoPositivo(seed?.estoques) > 20;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      let data = migrateState(JSON.parse(raw));
      const localHasStock = countSaldoPositivo(data.estoques) > 20;
      // Nova planilha, ou local vazio enquanto o seed tem números reais
      if (seedVer && (data.seedVersion !== seedVer || (seedHasStock && !localHasStock))) {
        data = applyOperationalFromSeed(data, seed);
        return data;
      }
      if (!Object.keys(data.receitasMinimoFabrica || {}).length) {
        data.receitasMinimoFabrica = seed.receitasMinimoFabrica || {};
      }
      if (!Object.keys(data.producaoAuto || {}).length) {
        data.producaoAuto = seed.producaoAuto || {};
      }
      if (!Object.keys(data.baldesPor || {}).length) {
        data.baldesPor = seed.baldesPor || {};
      }
      if (!data.produtosPorLoja || !Object.keys(data.produtosPorLoja).length) {
        data.produtosPorLoja = seed.produtosPorLoja || {};
      } else if (seed.produtosPorLoja) {
        Object.entries(seed.produtosPorLoja).forEach(([lid, ids]) => {
          if (!data.produtosPorLoja[lid]?.length && ids?.length) {
            data.produtosPorLoja[lid] = [...ids];
          }
        });
      }
      if (seed.estoques?.fabrica && !Object.keys(data.estoques.fabrica || {}).length) {
        data.estoques.fabrica = JSON.parse(JSON.stringify(seed.estoques.fabrica));
      }
      return data;
    }
  } catch (_) {}
  return migrateState(defaultState(seed));
}

async function reimportSeedFromPlanilha() {
  seedCache = null;
  const seed = await loadSeed();
  if (!seed?.produtos?.length) return false;
  state = applyOperationalFromSeed(state, seed);
  saveState();
  setupRoleFilters();
  render();
  return true;
}

function setSyncBadge(mode, text) {
  const el = document.getElementById("sync-badge");
  if (!el) return;
  el.className = `sync-badge ${mode || ""}`;
  el.textContent = text;
}

function getCloudConfig() {
  try {
    const raw = localStorage.getItem(CLOUD_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c.url && c.anonKey) return c;
    }
  } catch (_) {}
  const fromFile = window.APP_CLOUD || {};
  if (fromFile.url && fromFile.anonKey) return { url: fromFile.url, anonKey: fromFile.anonKey };
  return null;
}

function saveCloudConfig(url, anonKey) {
  localStorage.setItem(CLOUD_KEY, JSON.stringify({ url: url.trim(), anonKey: anonKey.trim() }));
}

function initSupabase() {
  const cfg = getCloudConfig();
  if (!cfg || typeof supabase === "undefined") {
    supabaseClient = null;
    setSyncBadge("", "● Local");
    return false;
  }
  try {
    supabaseClient = supabase.createClient(cfg.url, cfg.anonKey);
    setSyncBadge("online", "● Nuvem");
    return true;
  } catch (err) {
    console.error(err);
    supabaseClient = null;
    setSyncBadge("error", "● Erro nuvem");
    return false;
  }
}

async function pushToCloud() {
  if (!supabaseClient || applyingRemote) return;
  setSyncBadge("syncing", "● Enviando…");
  const { error } = await supabaseClient
    .from("app_state")
    .upsert({ id: "main", payload: state, updated_at: new Date().toISOString() });
  if (error) {
    console.error(error);
    setSyncBadge("error", "● Falha sync");
    return false;
  }
  lastCloudUpdatedAt = new Date().toISOString();
  setSyncBadge("online", "● Nuvem");
  return true;
}

async function pullFromCloud() {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient
    .from("app_state")
    .select("payload, updated_at")
    .eq("id", "main")
    .maybeSingle();
  if (error) {
    console.error(error);
    setSyncBadge("error", "● Falha leitura");
    return null;
  }
  if (!data?.payload || !Object.keys(data.payload).length) return null;
  return data;
}

async function applyRemoteState(payload, updatedAt) {
  applyingRemote = true;
  state = migrateState(payload);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  lastCloudUpdatedAt = updatedAt;
  if (session) {
    const user = state.usuarios.find((u) => u.id === session.userId);
    if (!user) logout();
    else {
      populateLoginUsers();
      setupRoleFilters();
      render();
    }
  } else {
    populateLoginUsers();
  }
  applyingRemote = false;
  setSyncBadge("online", "● Nuvem");
}

function subscribeCloud() {
  if (!supabaseClient) return;
  if (cloudChannel) {
    supabaseClient.removeChannel(cloudChannel);
    cloudChannel = null;
  }
  cloudChannel = supabaseClient
    .channel("app_state_changes")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "app_state", filter: "id=eq.main" },
      (payload) => {
        const row = payload.new;
        if (!row?.payload) return;
        if (row.updated_at && row.updated_at === lastCloudUpdatedAt) return;
        applyRemoteState(row.payload, row.updated_at);
        flashSave();
      }
    )
    .subscribe();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  localStorage.setItem(STORAGE_KEY + ":ts", new Date().toISOString());
  flashSave();
  if (supabaseClient && !applyingRemote) {
    clearTimeout(window.__cloudPushTimer);
    window.__cloudPushTimer = setTimeout(() => pushToCloud(), 700);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 350);
}

function flashSave() {
  const el = document.getElementById("save-indicator");
  if (!el) return;
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 1200);
}

function formatMoney(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatNum(v) {
  const n = Number(v || 0);
  return Number.isInteger(n) ? String(n) : n.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

function escAttr(str) {
  return esc(str).replace(/"/g, "&quot;");
}

function safePdfFilename(name) {
  return String(name || "relatorio")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

/**
 * Monta um clone imprimível fora de .view/.hidden (html2canvas captura vazio
 * quando o alvo fica em display:none ou muito fora da viewport, ex. left:-12000px).
 */
function buildPdfExportHost(element) {
  document.getElementById("pdf-export-host")?.remove();
  const host = document.createElement("div");
  host.id = "pdf-export-host";
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "190mm",
    maxWidth: "100vw",
    background: "#fff",
    color: "#000",
    zIndex: "0",
    opacity: "0",
    pointerEvents: "none",
    overflow: "visible",
  });

  const clone = element.cloneNode(true);
  clone.id = `${element.id || "pdf-export"}-clone`;
  clone.classList.remove("hidden");
  clone.removeAttribute("aria-hidden");
  clone.style.display = "block";
  clone.style.visibility = "visible";
  clone.style.position = "static";
  clone.style.left = "auto";
  clone.style.top = "auto";
  clone.style.width = "100%";
  clone.style.background = "#fff";
  clone.style.color = "#000";
  clone.style.zIndex = "auto";
  clone.style.opacity = "1";
  host.appendChild(clone);
  document.body.appendChild(host);
  return { host, clone };
}

/**
 * Exporta um elemento HTML para PDF (html2pdf). Fallback: impressão do navegador.
 */
async function exportElementToPdf(element, filename, printClass) {
  if (!element) {
    alert("Não achei o conteúdo do relatório.");
    return false;
  }

  // textContent (não innerText): elementos com display:none retornam innerText vazio.
  const contentText = String(element.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!contentText) {
    alert("Não há conteúdo para gerar o PDF. Ajuste o filtro ou as cotações.");
    return false;
  }

  const fname = `${safePdfFilename(filename)}.pdf`;
  const wasHidden = element.classList.contains("hidden");

  if (!window.html2pdf) {
    element.classList.remove("hidden");
    element.setAttribute("aria-hidden", "false");
    if (printClass) document.body.classList.add(printClass);
    alert('Biblioteca PDF indisponível. Na impressão, escolha "Salvar como PDF".');
    window.print();
    window.addEventListener(
      "afterprint",
      () => {
        if (printClass) document.body.classList.remove(printClass);
        if (wasHidden) {
          element.classList.add("hidden");
          element.setAttribute("aria-hidden", "true");
        }
      },
      { once: true }
    );
    return false;
  }

  const { host, clone } = buildPdfExportHost(element);
  if (printClass) document.body.classList.add(printClass);

  try {
    await waitForNextPaint();
    const cloneText = String(clone.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cloneText || clone.scrollHeight < 8) {
      alert("Não há conteúdo para gerar o PDF. Ajuste o filtro ou as cotações.");
      return false;
    }

    await window
      .html2pdf()
      .set({
        margin: [10, 10, 10, 10],
        filename: fname,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: "#ffffff",
          scrollX: 0,
          scrollY: 0,
          windowWidth: Math.max(clone.scrollWidth, 794),
          windowHeight: Math.max(clone.scrollHeight, 100),
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"] },
      })
      .from(clone)
      .save();
    return true;
  } catch (err) {
    console.error(err);
    alert("Falha ao gerar PDF. Tentando impressão…");
    element.classList.remove("hidden");
    element.setAttribute("aria-hidden", "false");
    if (printClass) document.body.classList.add(printClass);
    window.print();
    window.addEventListener(
      "afterprint",
      () => {
        if (wasHidden) {
          element.classList.add("hidden");
          element.setAttribute("aria-hidden", "true");
        }
      },
      { once: true }
    );
    return false;
  } finally {
    host.remove();
    if (printClass) {
      setTimeout(() => document.body.classList.remove(printClass), 800);
    }
  }
}

function lojaNome(id) {
  return getAllLojas().find((l) => l.id === id)?.nome || id;
}

function fornNome(id) {
  return getAllFornecedores().find((f) => f.id === id)?.nome || id;
}

function getProduto(id) {
  return state.produtos.find((p) => p.id === id);
}

function produtosAtivos() {
  return state.produtos.filter((p) => p.ativo);
}

/** Itens da planilha com filtro por loja (linhas ocultas = a loja não usa). */
function idsProdutosVisiveisLoja(lojaId) {
  const lista = state?.produtosPorLoja?.[lojaId];
  return Array.isArray(lista) && lista.length ? lista : null;
}

function produtoVisivelNaLoja(produtoId, lojaId) {
  const ids = idsProdutosVisiveisLoja(lojaId);
  if (!ids) return true;
  return ids.includes(produtoId);
}

function produtosDaLoja(lojaId, { incluirOcultos = false } = {}) {
  const ativos = produtosAtivos();
  if (incluirOcultos || !lojaId) return ativos;
  const ids = idsProdutosVisiveisLoja(lojaId);
  if (!ids) return ativos;
  const set = new Set(ids);
  return ativos.filter((p) => set.has(p.id));
}

function toggleProdutoNaLoja(lojaId, produtoId, incluir) {
  if (!state.produtosPorLoja) state.produtosPorLoja = {};
  let list = Array.isArray(state.produtosPorLoja[lojaId]) ? [...state.produtosPorLoja[lojaId]] : [];
  if (!list.length) {
    // se ainda não havia filtro, parte dos ativos atuais
    list = produtosAtivos().map((p) => p.id);
  }
  const set = new Set(list);
  if (incluir) set.add(produtoId);
  else set.delete(produtoId);
  state.produtosPorLoja[lojaId] = [...set];
  scheduleSave();
}

function categorias() {
  return [...new Set(state.produtos.map((p) => p.categoria).filter(Boolean))].sort();
}

function ensureEstoque(lojaId, produtoId) {
  if (!state.estoques[lojaId]) state.estoques[lojaId] = {};
  if (!state.estoques[lojaId][produtoId]) {
    state.estoques[lojaId][produtoId] = emptyEstoqueEntry();
  } else {
    migrateValidadesToLotes(state.estoques[lojaId][produtoId]);
  }
  return state.estoques[lojaId][produtoId];
}

function ensureCotacao(fornId, produtoId) {
  if (!state.cotacoes[fornId]) state.cotacoes[fornId] = {};
  if (!state.cotacoes[fornId][produtoId]) state.cotacoes[fornId][produtoId] = emptyCotacaoEntry();
  return state.cotacoes[fornId][produtoId];
}

function ensureProducao(produtoId) {
  if (!state.producao[produtoId]) state.producao[produtoId] = emptyProducaoEntry();
  return state.producao[produtoId];
}

function estoqueStatus(entry) {
  const saldo = Number(entry.saldo || 0);
  const min = Number(entry.minimo || 0);
  if (min > 0 && saldo < min) return "baixo";
  if (min > 0 && saldo <= min * 1.1) return "atencao";
  return "ok";
}

function listBaixoMinimo(lojaIds) {
  const ids = lojaIds || getLojas().map((l) => l.id);
  const list = [];
  produtosAtivos().forEach((p) => {
    ids.forEach((lojaId) => {
      const e = state.estoques[lojaId]?.[p.id];
      if (e && estoqueStatus(e) === "baixo") {
        list.push({
          produtoId: p.id,
          nome: p.nome,
          lojaId,
          loja: lojaNome(lojaId),
          saldo: Number(e.saldo || 0),
          min: Number(e.minimo || 0),
          central: lojaId === "central",
        });
      }
    });
  });
  list.sort((a, b) => Number(b.central) - Number(a.central) || a.loja.localeCompare(b.loja) || a.nome.localeCompare(b.nome));
  return list;
}

function countBaixoMinimo(lojaId) {
  return listBaixoMinimo([lojaId]).length;
}

/** Dias de antecipação para alerta “próximo do vencimento” (admin setting futuro). */
const VALIDADE_ALERTA_DIAS = 7;

function hojeLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysISO(iso, days) {
  const [y, m, d] = String(iso || "")
    .slice(0, 10)
    .split("-")
    .map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(y, m - 1, d + Number(days || 0));
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Lojas cujo estoque o usuário atual pode ver para alertas de validade. */
function lojasVisiveisValidade() {
  if (!session || session.role === "fornecedor") return [];
  if (session.role === "loja") return getLojas().filter((l) => l.id === session.lojaId);
  return getLojas();
}

/**
 * Escaneia lotes de produtos ativos (visíveis na loja).
 * Vencido: validade < hoje · Próximo: hoje ≤ validade ≤ hoje + N dias.
 */
function listValidadesAlerta({ dias = VALIDADE_ALERTA_DIAS } = {}) {
  const hoje = hojeLocalISO();
  const limite = addDaysISO(hoje, dias);
  const vencidos = [];
  const proximos = [];

  lojasVisiveisValidade().forEach((loja) => {
    produtosDaLoja(loja.id).forEach((p) => {
      const e = state.estoques[loja.id]?.[p.id];
      if (!e) return;
      migrateValidadesToLotes(e);
      (e.lotes || []).forEach((lote) => {
        const data = normalizeValidadeISO(lote.validade);
        if (!data) return;
        const item = {
          produtoId: p.id,
          nome: p.nome,
          lojaId: loja.id,
          loja: loja.nome || lojaNome(loja.id),
          loteId: lote.id,
          codigo: lote.codigo || "—",
          qtde: Number(lote.qtde) || 0,
          data,
        };
        if (data < hoje) vencidos.push(item);
        else if (data <= limite) proximos.push(item);
      });
    });
  });

  const byDateThenName = (a, b) =>
    a.data.localeCompare(b.data) || a.loja.localeCompare(b.loja) || a.nome.localeCompare(b.nome);
  vencidos.sort(byDateThenName);
  proximos.sort(byDateThenName);
  return { vencidos, proximos, dias };
}

function renderValidadeAlertList(items, limit = 12) {
  if (!items.length) return "";
  const shown = items.slice(0, limit);
  const more = items.length - shown.length;
  const rows = shown
    .map(
      (x) =>
        `<div class="alert-list-row">
          <button type="button" class="alert-list-item" data-goto-estoque="${esc(x.lojaId)}" data-produto-id="${esc(x.produtoId)}" data-produto-busca="${esc(x.nome)}" data-open-lotes="1">
            <strong>${esc(x.nome)}</strong>
            <span>${esc(x.loja)} · ${esc(x.codigo)} · qtde ${formatNum(x.qtde)} · ${formatDateBR(x.data)}</span>
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-goto-estoque="${esc(x.lojaId)}" data-produto-id="${esc(x.produtoId)}" data-produto-busca="${esc(x.nome)}" data-open-lotes="1">Gerenciar lotes</button>
        </div>`
    )
    .join("");
  return `<div class="alert-list">${rows}${
    more > 0 ? `<p class="alert-list-more">+${more} mais — abra Estoque para ver todos</p>` : ""
  }</div>`;
}

function gotoEstoqueValidade(lojaId, busca, produtoId, { openLotes = false } = {}) {
  const sel = document.getElementById("filter-loja");
  if (sel && lojaId) {
    sel.value = lojaId;
    sel.disabled = session.role === "loja";
  }
  const soBaixo = document.getElementById("filter-so-baixo");
  if (soBaixo) soBaixo.checked = false;
  const buscaEl = document.getElementById("filter-estoque-busca");
  if (buscaEl) buscaEl.value = busca || "";
  switchView("estoque");
  const lid = lojaId || lojaScope();
  const pid = produtoId || "";
  if (pid) {
    requestAnimationFrame(() => {
      const highlight = () => {
        const tr = document.querySelector(`#table-estoque tr[data-pid="${pid}"]`);
        const card = document.querySelector(`.estoque-card[data-pid="${pid}"]`);
        document.querySelectorAll(".row-highlight, .estoque-card-highlight").forEach((el) => {
          el.classList.remove("row-highlight", "estoque-card-highlight");
        });
        if (tr) {
          tr.classList.add("row-highlight");
          tr.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        if (card) {
          card.classList.add("estoque-card-highlight");
          card.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      };
      highlight();
      if (openLotes && lid) openLotesModal(lid, pid);
    });
  }
}

function gotoEstoqueBaixo(lojaId) {
  const sel = document.getElementById("filter-loja");
  if (sel && lojaId) {
    sel.value = lojaId;
    sel.disabled = session.role === "loja";
  }
  const soBaixo = document.getElementById("filter-so-baixo");
  if (soBaixo) soBaixo.checked = true;
  const buscaEl = document.getElementById("filter-estoque-busca");
  if (buscaEl) buscaEl.value = "";
  switchView("estoque");
}

function handleDashGoto(action, el) {
  if (!action) return;
  if (action === "estoque-baixo") {
    const lid =
      session.role === "loja"
        ? session.lojaId
        : el?.dataset?.lojaId || document.getElementById("filter-loja")?.value || "";
    gotoEstoqueBaixo(lid);
  } else if (action === "estoque-central") {
    gotoEstoqueBaixo("central");
  } else if (action === "estoque-validade") {
    gotoEstoqueValidade(session.role === "loja" ? session.lojaId : "", "");
  } else if (action === "emergencia") {
    switchView("emergencia");
  } else if (action === "producao") {
    switchView("producao");
  } else if (action === "cotacao") {
    switchView(session.role === "admin" ? "resultado" : "cotacao");
  } else if (action === "envio") {
    switchView("envio-sexta");
  } else if (action === "estoque") {
    switchView("estoque");
  }
}

function isLojaOperacional(lojaId) {
  return !!(lojaId && lojaId !== "central" && lojaId !== "fabrica");
}

function canManageEmergencia() {
  return session?.role === "admin" || (session?.role === "loja" && session.lojaId === "central");
}

function canCreateEmergencia() {
  if (!session) return false;
  if (session.role === "admin") return true;
  if (session.role === "loja" && session.lojaId === "central") return true;
  return session.role === "loja" && isLojaOperacional(session.lojaId);
}

function emergenciaCreateNeedsLojaSelect() {
  return session?.role === "admin" || (session?.role === "loja" && session.lojaId === "central");
}

function getLojasOperacionaisEmergencia() {
  return getLojas().filter((l) => isLojaOperacional(l.id));
}

/** Origens possíveis ao enviar emergência: Central + lojas operacionais (destino permanece na lista, com aviso no envio). */
function getOrigensEmergencia() {
  const lojas = getLojas();
  const central = lojas.find((l) => l.id === "central");
  const ops = lojas.filter((l) => isLojaOperacional(l.id));
  return [...(central ? [central] : [{ id: "central", nome: "Central" }]), ...ops];
}

function getEmergenciaLojaIdForCreate() {
  if (emergenciaCreateNeedsLojaSelect()) {
    return document.getElementById("emergencia-loja")?.value || "";
  }
  return session?.lojaId || "";
}

function getSolicitacoesEmergencia() {
  return state.solicitacoesEmergencia || [];
}

function pushHistoricoEmergencia(sol, status, nota) {
  if (!Array.isArray(sol.historico)) sol.historico = [];
  sol.historico.push({
    status,
    at: new Date().toISOString(),
    by: session?.userId || "",
    nome: session?.nome || "",
    nota: nota || "",
  });
}

function qtdeComprarProduto(produtoId) {
  let atual = 0;
  let minimo = 0;
  getLojas().forEach((l) => {
    const e = state.estoques[l.id]?.[produtoId];
    if (!e) return;
    atual += Number(e.saldo || 0);
    minimo += Number(e.minimo || 0);
  });
  return { atual, minimo, comprar: Math.max(0, minimo - atual) };
}

/** Avalia fórmula lilás de mínimo da fábrica (só números e Q['id']). */
function evalReceitaMinimo(expr, Q) {
  if (!expr) return 0;
  const safe = String(expr).replace(/Q\['([^']+)'\]/g, (_, id) => String(Number(Q[id] || 0)));
  if (!/^[\d.\s+\-*/()]+$/.test(safe)) return 0;
  try {
    const n = Function(`"use strict"; return (${safe});`)();
    return Number.isFinite(n) ? Math.max(0, Number(n)) : 0;
  } catch {
    return 0;
  }
}

/**
 * Compra = estoque mínimo consolidado − atual (todas as lojas + fábrica).
 * Lista de produção da fábrica = itens cuja necessidade (qtde a comprar) > 0.
 * Mínimos lilás da fábrica = fórmulas de receita sobre o total a produzir.
 * Se o usuário marcar mínimo manual, a fórmula não sobrescreve.
 */
function syncProducaoEMinimosFabrica() {
  if (!state) return;
  const receitas = state.receitasMinimoFabrica || seedCache?.receitasMinimoFabrica || {};
  const autoMap = state.producaoAuto || seedCache?.producaoAuto || {};
  const baldesPor = state.baldesPor || seedCache?.baldesPor || {};
  let dirty = false;

  // 1) Total a produzir = necessidade de compra (como TOTAIS!G → FABRICA!H)
  const Q = {};
  Object.keys(autoMap).forEach((pid) => {
    const need = qtdeComprarProduto(pid).comprar;
    Q[pid] = need;
    const pr = ensureProducao(pid);
    const lista = need > 0 || autoMap[pid]?.sempreLista ? "PRODUZIR" : "";
    const baldes = baldesPor[pid] && need > 0 ? need / Number(baldesPor[pid]) : baldesPor[pid] ? 0 : pr.qtdeBaldes;
    if (pr.totalProduzir !== need || pr.lista !== lista) dirty = true;
    pr.totalProduzir = need;
    pr.lista = lista;
    if (baldesPor[pid]) {
      if (pr.qtdeBaldes !== baldes) dirty = true;
      pr.qtdeBaldes = baldes;
    }
  });

  // 2) Células lilás: mínimo da fábrica por fórmula (respeita override manual)
  Object.entries(receitas).forEach(([pid, meta]) => {
    const entry = ensureEstoque("fabrica", pid);
    if (entry.minimoManual) {
      entry.minimoAuto = false;
      return;
    }
    const next = Math.round(evalReceitaMinimo(meta.expr, Q) * 1000) / 1000;
    if (entry.minimo !== next || !entry.minimoAuto) dirty = true;
    entry.minimo = next;
    entry.minimoAuto = true;
    entry.minimoManual = false;
  });

  if (dirty) scheduleSave();
}

function hasReceitaFabrica(produtoId) {
  return !!(state.receitasMinimoFabrica || {})[produtoId];
}

function descricaoReceitaFabrica(produtoId) {
  const meta = (state.receitasMinimoFabrica || {})[produtoId];
  if (!meta?.expr) return "";
  return String(meta.expr)
    .replace(/Q\['([^']+)'\]/g, (_, id) => getProduto(id)?.nome || id)
    .replace(/\*/g, " × ")
    .replace(/\+/g, " + ");
}

function canEditMinimoFabrica() {
  return session?.role === "admin" || (session?.role === "loja" && session.lojaId === "fabrica");
}

/** Modo efetivo do mínimo fábrica: "fixo" | "formula" (só itens com receita). */
function minimoModoFabrica(entry, produtoId) {
  if (!hasReceitaFabrica(produtoId)) return "fixo";
  return entry?.minimoManual ? "fixo" : "formula";
}

function badgeMinimoModoHtml(modo) {
  if (modo === "formula") {
    return `<span class="badge badge-modo-formula" title="Calculado pela fórmula">Fórmula</span>`;
  }
  return `<span class="badge badge-modo-fixo" title="Valor fixo manual">Fixo</span>`;
}

function setMinimoEstoque(lojaId, produtoId, valor, { manualOverride = false } = {}) {
  const entry = ensureEstoque(lojaId, produtoId);
  entry.minimo = Math.max(0, Number(valor) || 0);
  if (lojaId === "fabrica" && hasReceitaFabrica(produtoId)) {
    if (manualOverride) {
      entry.minimoManual = true;
      entry.minimoAuto = false;
    }
    // Sem override: só grava o número se já estiver em Fixo; em Fórmula o sync recalcula.
  } else {
    entry.minimoManual = false;
    entry.minimoAuto = false;
  }
  scheduleSave();
  return entry;
}

function restaurarMinimoFormula(produtoId) {
  const entry = ensureEstoque("fabrica", produtoId);
  entry.minimoManual = false;
  entry.minimoAuto = true;
  syncProducaoEMinimosFabrica();
  scheduleSave();
  return entry;
}

/**
 * Alterna Fixo ↔ Fórmula no mínimo da fábrica.
 * Fórmula → Fixo: mantém o valor calculado atual como ponto de partida.
 * Fixo → Fórmula: confirma (valor fixo será sobrescrito pelo cálculo).
 */
function setMinimoModoFabrica(produtoId, modo, { confirmRestore = true } = {}) {
  if (!hasReceitaFabrica(produtoId)) return null;
  const entry = ensureEstoque("fabrica", produtoId);
  if (modo === "fixo") {
    entry.minimoManual = true;
    entry.minimoAuto = false;
    scheduleSave();
    return entry;
  }
  if (entry.minimoManual && confirmRestore) {
    const ok = confirm(
      "Voltar à fórmula?\n\nO valor fixo atual será substituído pelo cálculo automático."
    );
    if (!ok) return null;
  }
  return restaurarMinimoFormula(produtoId);
}

function openMinimoFabricaModal(produtoId) {
  if (!canEditMinimoFabrica()) {
    alert("Somente Admin ou Fábrica podem alterar o modo/fórmula do mínimo.");
    return;
  }
  const p = getProduto(produtoId);
  const meta = (state.receitasMinimoFabrica || {})[produtoId];
  if (!p || !meta) return;
  const entry = ensureEstoque("fabrica", produtoId);
  const desc = descricaoReceitaFabrica(produtoId);
  const modoAtual = minimoModoFabrica(entry, produtoId);

  document.getElementById("modal-title").textContent = `Mínimo fábrica — ${p.nome}`;
  document.getElementById("modal-body").innerHTML = `
    <p class="toolbar-hint">Escolha <strong>Fórmula</strong> (mínimo recalculado) ou <strong>Fixo</strong> (número manual). Em Fixo a fórmula fica pausada até você voltar.</p>
    <label class="field"><span>Modo</span>
      <select id="mf-modo">
        <option value="formula" ${modoAtual === "formula" ? "selected" : ""}>Fórmula</option>
        <option value="fixo" ${modoAtual === "fixo" ? "selected" : ""}>Fixo</option>
      </select>
    </label>
    <label class="field"><span>Valor mínimo (KG/UN)</span>
      <input id="mf-minimo" step="any" type="number" value="${entry.minimo ?? 0}" /></label>
    <label class="field"><span>Fórmula (editável)</span>
      <textarea id="mf-expr" rows="3">${esc(meta.expr || "")}</textarea></label>
    <p class="field-hint">Legível: <code>${esc(desc)}</code><br/>Use Q['id-do-produto'] para totais a produzir. Ex.: (Q['box-carreteiro-300g'])*0.079</p>`;

  const modal = document.getElementById("modal");
  modal.showModal();
  const syncMode = () => {
    const fixo = document.getElementById("mf-modo").value === "fixo";
    document.getElementById("mf-minimo").disabled = !fixo;
  };
  document.getElementById("mf-modo").addEventListener("change", () => {
    const sel = document.getElementById("mf-modo");
    // Fórmula → Fixo: manter valor atual (já no input) como pontapé do fixo
    if (sel.value === "fixo") {
      document.getElementById("mf-minimo").value = entry.minimo ?? 0;
    }
    syncMode();
  });
  syncMode();

  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    const modo = document.getElementById("mf-modo").value;
    const expr = document.getElementById("mf-expr").value.trim();
    if (expr) {
      if (!state.receitasMinimoFabrica) state.receitasMinimoFabrica = {};
      state.receitasMinimoFabrica[produtoId] = { ...(meta || {}), expr, autoMinimo: true };
    }
    if (modo === "fixo") {
      setMinimoEstoque("fabrica", produtoId, document.getElementById("mf-minimo").value, {
        manualOverride: true,
      });
    } else {
      const restored = setMinimoModoFabrica(produtoId, "formula", {
        confirmRestore: modoAtual === "fixo",
      });
      if (!restored) return;
    }
    modal.close();
    setupRoleFilters();
    render();
  };
}

function openLotesModal(lojaId, produtoId) {
  const p = getProduto(produtoId);
  const entry = ensureEstoque(lojaId, produtoId);
  if (!p) return;

  const canEdit = session.role === "admin" || (session.role === "loja" && session.lojaId === lojaId);
  let draft = (entry.lotes || []).map((l) => ({ ...emptyLote(l) }));

  const modal = document.getElementById("modal");
  const saveBtn = document.getElementById("modal-save");
  const cancelBtn = document.getElementById("modal-cancel");
  modal.classList.add("modal-wide");
  if (saveBtn) {
    saveBtn.classList.toggle("hidden", !canEdit);
    saveBtn.textContent = "Salvar";
  }
  if (cancelBtn) cancelBtn.textContent = canEdit ? "Cancelar" : "Fechar";

  const readDraftFromDom = () => {
    const rows = [...document.querySelectorAll("#lotes-editor .lote-row")];
    draft = rows.map((row) =>
      emptyLote({
        id: row.dataset.loteId || uid(),
        codigo: row.querySelector("[data-lote-field=codigo]")?.value || "",
        qtde: row.querySelector("[data-lote-field=qtde]")?.value,
        validade: row.querySelector("[data-lote-field=validade]")?.value || "",
      })
    );
  };

  const paint = () => {
    const soma = draft.reduce((s, l) => s + (Number(l.qtde) || 0), 0);
    const saldo = Number(entry.saldo) || 0;
    const mismatch = draft.length > 0 && Math.abs(soma - saldo) > 1e-6;
    const dis = canEdit ? "" : "disabled";
    document.getElementById("modal-title").textContent = `Lotes — ${p.nome}`;
    document.getElementById("modal-body").innerHTML = `
      <p class="toolbar-hint">
        Loja: <strong>${esc(lojaNome(lojaId))}</strong> ·
        Saldo: <strong>${formatNum(saldo)}</strong> ${esc(p.unidade || "")}
        ${
          draft.length
            ? ` · Soma lotes: <strong>${formatNum(soma)}</strong>${
                mismatch ? ' <span class="lotes-mismatch">(difere do saldo)</span>' : ""
              }`
            : ""
        }
      </p>
      <div class="lotes-editor" id="lotes-editor">
        ${
          draft.length
            ? draft
                .map(
                  (l) => `
          <div class="lote-row" data-lote-id="${esc(l.id)}">
            <label class="field lote-field">
              <span>Código</span>
              <input data-lote-field="codigo" ${dis} type="text" value="${escAttr(l.codigo)}" placeholder="Opcional" />
            </label>
            <label class="field lote-field">
              <span>Qtde</span>
              <input data-lote-field="qtde" ${dis} step="any" type="number" value="${l.qtde}" />
            </label>
            <label class="field lote-field">
              <span>Validade</span>
              <input data-lote-field="validade" ${dis} type="date" value="${escAttr(l.validade)}" />
            </label>
            ${
              canEdit
                ? `<button class="btn btn-ghost btn-sm lote-del" data-lote-del="${esc(l.id)}" type="button" title="Remover lote">✕</button>`
                : ""
            }
          </div>`
                )
                .join("")
            : '<p class="empty-state">Nenhum lote cadastrado</p>'
        }
      </div>
      ${canEdit ? '<button class="btn btn-ghost" id="lote-add" type="button">+ Adicionar lote</button>' : ""}
      ${
        canEdit && mismatch
          ? `<button class="btn" id="lote-igualar-saldo" type="button">Igualar saldo à soma dos lotes (${formatNum(soma)})</button>`
          : ""
      }
      <p class="field-hint">A soma das quantidades é só um aviso — o saldo do produto continua independente.</p>`;

    document.getElementById("lote-add")?.addEventListener("click", () => {
      readDraftFromDom();
      draft.push(emptyLote({ codigo: "", qtde: 0, validade: "" }));
      paint();
    });
    document.getElementById("lote-igualar-saldo")?.addEventListener("click", () => {
      readDraftFromDom();
      const somaNow = draft.reduce((s, l) => s + (Number(l.qtde) || 0), 0);
      entry.lotes = draft
        .map((l) => emptyLote(l))
        .filter((l) => l.validade || l.codigo || Number(l.qtde));
      migrateValidadesToLotes(entry);
      const de = Number(entry.saldo) || 0;
      entry.saldo = Math.round(somaNow * 1000) / 1000;
      pushMovimento({
        lojaId,
        produtoId,
        de,
        para: entry.saldo,
        motivo: "correcao",
        nota: "Igualar saldo à soma dos lotes",
        tipo: "ajuste",
      });
      scheduleSave();
      paint();
      if (document.getElementById("view-estoque")?.classList.contains("active")) renderEstoque();
    });
    document.querySelectorAll("[data-lote-del]").forEach((btn) => {
      btn.addEventListener("click", () => {
        readDraftFromDom();
        draft = draft.filter((l) => l.id !== btn.dataset.loteDel);
        paint();
      });
    });
  };

  paint();
  modal.showModal();

  const onClose = () => {
    modal.classList.remove("modal-wide");
    if (saveBtn) saveBtn.classList.remove("hidden");
    if (cancelBtn) cancelBtn.textContent = "Cancelar";
    modal.removeEventListener("close", onClose);
  };
  modal.addEventListener("close", onClose);

  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    if (!canEdit) {
      modal.close();
      return;
    }
    readDraftFromDom();
    entry.lotes = draft
      .map((l) => emptyLote(l))
      .filter((l) => l.validade || l.codigo || Number(l.qtde));
    migrateValidadesToLotes(entry);
    scheduleSave();
    modal.close();
    if (document.getElementById("view-estoque")?.classList.contains("active")) renderEstoque();
    else render();
  };
}

function melhorCotacao(produtoId, { exigirOk = true } = {}) {
  let best = null;
  getFornecedores().forEach((f) => {
    const c = state.cotacoes[f.id]?.[produtoId];
    if (!c || Number(c.preco) <= 0) return;
    if (exigirOk && String(c.status).toUpperCase() !== "OK") return;
    if (!best || Number(c.preco) < best.preco) {
      best = {
        fornecedorId: f.id,
        nome: f.nome,
        preco: Number(c.preco),
        qtde: Number(c.qtde || 0),
        ok: String(c.status).toUpperCase() === "OK",
      };
    }
  });
  return best;
}

/** Preço de referência: 1) menor OK 2) menor preço qualquer 3) último snapshot. */
function precoReferenciaInfo(produtoId) {
  const ok = melhorCotacao(produtoId, { exigirOk: true });
  if (ok) {
    return { preco: ok.preco, fornecedorId: ok.fornecedorId, nome: ok.nome, fonte: "Cotação OK" };
  }
  const any = melhorCotacao(produtoId, { exigirOk: false });
  if (any) {
    return { preco: any.preco, fornecedorId: any.fornecedorId, nome: any.nome, fonte: "Cotação" };
  }
  const hist = (state.historicoPrecos || []).slice().sort((a, b) => String(b.data).localeCompare(String(a.data)));
  for (const snap of hist) {
    const row = snap.precos?.[produtoId];
    if (row && Number(row.preco) > 0) {
      return {
        preco: Number(row.preco),
        fornecedorId: row.fornecedorId || "",
        nome: row.fornecedorNome || "Histórico",
        fonte: "Histórico",
      };
    }
  }
  return { preco: 0, fornecedorId: "", nome: "", fonte: "" };
}

function precoReferencia(produtoId) {
  return precoReferenciaInfo(produtoId).preco || 0;
}

/** Produtos ativos sem preço utilizável (sem OK, sem cotação >0, sem histórico). */
function itensSemPreco() {
  return produtosAtivos()
    .filter((p) => precoReferencia(p.id) <= 0)
    .slice()
    .sort(
      (a, b) =>
        String(a.categoria || "").localeCompare(String(b.categoria || ""), "pt-BR") ||
        String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR")
    );
}

function canBaixarItensSemPreco() {
  return session?.role === "admin" || (session?.role === "loja" && session.lojaId === "central");
}

function downloadItensSemPrecoXls() {
  if (!canBaixarItensSemPreco()) return;
  const itens = itensSemPreco();
  if (!itens.length) {
    alert("Nenhum item ativo sem preço de referência.");
    return;
  }
  const rows = itens
    .map(
      (p) =>
        `<tr><td>${esc(p.categoria || "")}</td><td>${esc(p.nome || "")}</td><td>${esc(p.unidade || "")}</td><td>${esc(p.id || "")}</td></tr>`
    )
    .join("");
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8" /></head><body><table>
<thead><tr><th>Categoria</th><th>Produto</th><th>Unidade</th><th>Id</th></tr></thead>
<tbody>${rows}</tbody>
</table></body></html>`;
  const blob = new Blob([`\ufeff${html}`], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "itens-sem-preco.xls";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function snapshotPrecosAtual(label) {
  const precos = {};
  let itens = 0;
  produtosAtivos().forEach((p) => {
    const info = precoReferenciaInfo(p.id);
    if (info.preco <= 0) return;
    precos[p.id] = {
      preco: info.preco,
      fornecedorId: info.fornecedorId,
      fornecedorNome: info.nome,
      fonte: info.fonte,
    };
    itens += 1;
  });
  const totaisLoja = {};
  getLojas().forEach((l) => {
    totaisLoja[l.id] = valorEstoqueLoja(l.id).valor;
  });
  const snap = {
    id: uid(),
    data: new Date().toISOString(),
    label: label || `Preços ${formatDateBR(hojeISO())}`,
    precos,
    itens,
    totaisLoja,
    totalGeral: valorEstoqueGeral().valor,
  };
  if (!Array.isArray(state.historicoPrecos)) state.historicoPrecos = [];
  state.historicoPrecos.unshift(snap);
  // keep last 52 snapshots (~1 year weekly)
  if (state.historicoPrecos.length > 52) state.historicoPrecos.length = 52;
  scheduleSave();
  return snap;
}

function ultimoSnapshotPrecos() {
  const list = state.historicoPrecos || [];
  return list.length ? list[0] : null;
}

function getSnapshotById(id) {
  return (state.historicoPrecos || []).find((s) => s.id === id) || null;
}

function indiceInflacao(precoBase, precoAtual) {
  const b = Number(precoBase) || 0;
  const a = Number(precoAtual) || 0;
  if (b <= 0 || a <= 0) return null;
  return ((a / b) - 1) * 100;
}

function formatPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function valorEstoqueLoja(lojaId) {
  let valor = 0;
  let itensComSaldo = 0;
  let semPreco = 0;
  produtosAtivos().forEach((p) => {
    const saldo = Number(ensureEstoque(lojaId, p.id).saldo) || 0;
    if (saldo <= 0) return;
    itensComSaldo += 1;
    const preco = precoReferencia(p.id);
    if (preco > 0) valor += saldo * preco;
    else semPreco += 1;
  });
  return { valor, itensComSaldo, semPreco };
}

function valorEstoqueGeral(lojaIds) {
  const ids = lojaIds || getLojas().map((l) => l.id);
  let valor = 0;
  let semPreco = 0;
  ids.forEach((id) => {
    const v = valorEstoqueLoja(id);
    valor += v.valor;
    semPreco += v.semPreco;
  });
  return { valor, semPreco };
}

/* ── Auth ── */
function can(view) {
  if (!session) return false;
  if (session.role === "admin") return true;
  if (session.role === "loja") {
    const views = ["dashboard", "contagem", "estoque", "envio-sexta", "valores"];
    if (isLojaOperacional(session.lojaId) || session.lojaId === "central") {
      views.push("emergencia");
    }
    if (session.lojaId === "fabrica") views.push("producao");
    return views.includes(view);
  }
  if (session.role === "fornecedor") return ["dashboard", "cotacao", "pedidos", "configuracoes"].includes(view);
  return false;
}

function canManageEnvio() {
  return session?.role === "admin" || (session?.role === "loja" && session.lojaId === "central");
}

function lojaScope() {
  if (session?.role === "loja") return session.lojaId;
  return document.getElementById("filter-loja")?.value || "central";
}

function fornScope() {
  if (session?.role === "fornecedor") return session.fornecedorId;
  return document.getElementById("filter-fornecedor")?.value || getFornecedores()[0]?.id || "";
}

/** IDs de produtos que este fornecedor ocultou da própria cotação (não remove do catálogo). */
function getItensOcultosFornecedor(fid) {
  if (!fid || !state?.fornecedorItensOcultos) return [];
  const list = state.fornecedorItensOcultos[fid];
  return Array.isArray(list) ? list : [];
}

function isItemOcultoFornecedor(fid, produtoId) {
  return getItensOcultosFornecedor(fid).includes(produtoId);
}

function setItemOcultoFornecedor(fid, produtoId, oculto) {
  if (!fid || !produtoId) return;
  if (!state.fornecedorItensOcultos) state.fornecedorItensOcultos = {};
  const set = new Set(getItensOcultosFornecedor(fid));
  if (oculto) set.add(produtoId);
  else set.delete(produtoId);
  state.fornecedorItensOcultos[fid] = [...set];
}

function setTodosItensOcultosFornecedor(fid, ocultar) {
  if (!fid) return;
  if (!state.fornecedorItensOcultos) state.fornecedorItensOcultos = {};
  state.fornecedorItensOcultos[fid] = ocultar ? produtosAtivos().map((p) => p.id) : [];
}

function populateLoginUsers() {
  const sel = document.getElementById("login-user");
  const groups = [
    { label: "Administração", role: "admin" },
    { label: "Lojas", role: "loja" },
    { label: "Fornecedores", role: "fornecedor" },
  ];
  sel.innerHTML = groups
    .map((g) => {
      const opts = state.usuarios
        .filter((u) => u.role === g.role)
        .map((u) => `<option value="${u.id}">${esc(u.nome)} (${u.id})</option>`)
        .join("");
      return `<optgroup label="${g.label}">${opts}</optgroup>`;
    })
    .join("");
}

function tryLogin(userId, password) {
  const user = state.usuarios.find((u) => u.id === userId);
  if (!user || user.password !== password) return false;
  session = {
    userId: user.id,
    nome: user.nome,
    role: user.role,
    lojaId: user.lojaId || "",
    fornecedorId: user.fornecedorId || "",
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return true;
}

function logout() {
  session = null;
  localStorage.removeItem(SESSION_KEY);
  hideTableHScrollFooter();
  document.body.classList.remove("has-mobile-nav");
  document.getElementById("mobile-bottom-nav")?.classList.add("hidden");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("login-pass").value = "";
  document.getElementById("login-error").classList.add("hidden");
}

function restoreSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    const user = state.usuarios.find((u) => u.id === s.userId);
    if (!user) return false;
    session = {
      userId: user.id,
      nome: user.nome,
      role: user.role,
      lojaId: user.lojaId || "",
      fornecedorId: user.fornecedorId || "",
    };
    return true;
  } catch {
    return false;
  }
}

function enterApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("session-role").textContent =
    session.role === "admin" ? "Administração" : session.role === "loja" ? "Loja" : "Fornecedor";
  document.getElementById("session-name").textContent = session.nome;
  buildNav();
  bindMobileBottomNav();
  updateMobileBottomNav();
  const first =
    session.role === "fornecedor"
      ? "cotacao"
      : session.role === "loja" && session.lojaId === "fabrica"
        ? "producao"
        : session.role === "loja"
          ? "contagem" // domingo e demais: contagem de estoque
          : "dashboard";
  switchView(first);
  setupRoleFilters();
  render();
}

function buildNav() {
  const items = [];
  if (can("dashboard")) items.push(["dashboard", "📊", "Dashboard"]);
  if (can("contagem")) items.push(["contagem", "🔢", "Contagem"]);
  if (can("estoque")) items.push(["estoque", "📦", session.role === "loja" ? "Estoque detalhado" : "Estoque"]);
  if (can("envio-sexta")) items.push(["envio-sexta", "🚚", "Envio"]);
  if (can("emergencia")) items.push(["emergencia", "🚨", "Emergência"]);
  if (can("producao")) items.push(["producao", "🏭", "Produção"]);
  if (can("cotacao")) items.push(["cotacao", "💰", "Cotação"]);
  if (can("resultado")) items.push(["resultado", "🏆", "Resultado"]);
  if (can("pedidos")) {
    items.push([
      "pedidos",
      "📋",
      session.role === "fornecedor" ? "Meus pedidos" : "Pedidos",
    ]);
  }
  if (can("valores")) items.push(["valores", "💵", "Valores"]);

  document.getElementById("nav").innerHTML = items
    .map(
      ([id, icon, label]) =>
        `<button class="nav-btn" data-view="${id}" type="button"><span>${icon}</span> ${label}</button>`
    )
    .join("");

  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  const btnConfig = document.getElementById("btn-config");
  if (btnConfig) {
    btnConfig.classList.toggle("hidden", !can("configuracoes"));
  }
}

function setupRoleFilters() {
  const lojaSel = document.getElementById("filter-loja");
  lojaSel.innerHTML = getLojas().map((l) => `<option value="${l.id}">${esc(l.nome)}</option>`).join("");
  if (session.role === "loja") {
    lojaSel.value = session.lojaId;
    lojaSel.disabled = true;
  } else {
    lojaSel.disabled = false;
  }

  const fornSel = document.getElementById("filter-fornecedor");
  fornSel.innerHTML = getFornecedores().map((f) => `<option value="${f.id}">${esc(f.nome)}</option>`).join("");
  if (session.role === "fornecedor") {
    fornSel.value = session.fornecedorId;
    fornSel.disabled = true;
    document.getElementById("cotacao-hint").textContent =
      `Você está cotando como ${session.nome}. Só esta cotação é editável.`;
  } else {
    fornSel.disabled = false;
    document.getElementById("cotacao-hint").textContent = "Selecione o fornecedor e preencha preços / status.";
  }
  const btnItens = document.getElementById("btn-gerenciar-itens-cotacao");
  if (btnItens) btnItens.classList.toggle("hidden", session.role !== "fornecedor");

  const catOpts =
    '<option value="">Todas as categorias</option>' +
    categorias().map((c) => `<option value="${escAttr(c)}">${esc(c)}</option>`).join("");
  document.getElementById("filter-categoria").innerHTML = catOpts;
  document.getElementById("filter-cot-categoria").innerHTML = catOpts;
  const contCat = document.getElementById("filter-contagem-categoria");
  if (contCat) contCat.innerHTML = catOpts;

  const contLoja = document.getElementById("filter-contagem-loja");
  if (contLoja) {
    contLoja.innerHTML = getLojas().map((l) => `<option value="${l.id}">${esc(l.nome)}</option>`).join("");
    if (session.role === "loja") {
      contLoja.value = session.lojaId;
      contLoja.classList.add("hidden");
    } else {
      contLoja.classList.remove("hidden");
    }
  }

  const valLoja = document.getElementById("filter-valores-loja");
  if (valLoja) {
    const prev = valLoja.value;
    if (session.role === "loja") {
      valLoja.innerHTML = `<option value="${session.lojaId}">${esc(lojaNome(session.lojaId))}</option>`;
      valLoja.value = session.lojaId;
      valLoja.disabled = true;
    } else {
      valLoja.disabled = false;
      valLoja.innerHTML =
        `<option value="">Todas as lojas</option>` +
        getLojas().map((l) => `<option value="${l.id}">${esc(l.nome)}</option>`).join("");
      if (prev && [...valLoja.options].some((o) => o.value === prev)) valLoja.value = prev;
    }
  }

  setupEnvioLojaFilter();
}

function setupEnvioLojaFilter() {
  const sel = document.getElementById("filter-envio-loja");
  if (!sel) return;
  const destinos = getLojas().filter((l) => l.id !== "central");
  const prev = sel.value;
  sel.innerHTML = destinos.map((l) => `<option value="${l.id}">${esc(l.nome)}</option>`).join("");
  if (session.role === "loja" && session.lojaId !== "central") {
    sel.value = session.lojaId;
    sel.disabled = true;
  } else {
    sel.disabled = false;
    if (prev && destinos.some((l) => l.id === prev)) sel.value = prev;
    else if (destinos[0]) sel.value = destinos[0].id;
  }
  const dataEl = document.getElementById("filter-envio-data");
  if (dataEl && !dataEl.value) dataEl.value = toISODate(proximoOuAtualFriday());
}

function switchView(view) {
  // Fornecedores virou aba em Configurações
  if (view === "fornecedores") {
    configTab = "fornecedores";
    view = "configuracoes";
  }
  if (!can(view)) return;
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  document.getElementById("btn-config")?.classList.toggle("active-config", view === "configuracoes");
  let [title, sub] = VIEW_META[view] || ["", ""];
  if (view === "pedidos" && session.role === "fornecedor") {
    title = "Meus pedidos";
    sub = "Pedidos emitidos para você";
  }
  document.getElementById("view-title").textContent = title;
  document.getElementById("view-subtitle").textContent = sub;
  document.getElementById("sidebar").classList.remove("open");
  updateMobileBottomNav(view);
  render();
}

function shouldShowMobileBottomNav() {
  if (!session || session.role !== "loja") return false;
  return isLojaOperacional(session.lojaId) || session.lojaId === "fabrica" || session.lojaId === "central";
}

function updateMobileBottomNav(activeView) {
  const nav = document.getElementById("mobile-bottom-nav");
  if (!nav) return;
  const show = shouldShowMobileBottomNav();
  nav.classList.toggle("hidden", !show);
  document.body.classList.toggle("has-mobile-nav", show);
  const view = activeView || document.querySelector(".view.active")?.id?.replace("view-", "") || "";

  const midBtn = nav.querySelector("[data-mobile-mid]");
  if (midBtn) {
    if (session?.lojaId === "fabrica" && can("producao")) {
      midBtn.dataset.view = "producao";
      midBtn.innerHTML = "<span>🏭</span> Produção";
      midBtn.classList.toggle("hidden", false);
    } else if (can("emergencia")) {
      midBtn.dataset.view = "emergencia";
      midBtn.innerHTML = "<span>🚨</span> Emergência";
      midBtn.classList.toggle("hidden", false);
    } else {
      midBtn.classList.add("hidden");
    }
  }

  nav.querySelectorAll(".mobile-nav-btn[data-view]").forEach((btn) => {
    const vid = btn.dataset.view;
    if (!btn.hasAttribute("data-mobile-mid")) {
      btn.classList.toggle("hidden", !can(vid));
    }
    btn.classList.toggle("active", vid === view);
  });
}

function bindMobileBottomNav() {
  const nav = document.getElementById("mobile-bottom-nav");
  if (!nav || nav.dataset.bound === "1") return;
  nav.dataset.bound = "1";
  nav.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".mobile-nav-btn");
    if (!btn) return;
    if (btn.hasAttribute("data-mobile-menu")) {
      document.getElementById("sidebar")?.classList.toggle("open");
      return;
    }
    if (btn.dataset.view) switchView(btn.dataset.view);
  });
}

function bindFiltersCollapse() {
  const bind = (btnId, extraId) => {
    const btn = document.getElementById(btnId);
    const extra = document.getElementById(extraId);
    if (!btn || !extra || btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const isOpen = extra.classList.toggle("collapsed") === false;
      btn.setAttribute("aria-expanded", isOpen ? "true" : "false");
      btn.textContent = isOpen ? "Menos filtros" : "Mais filtros";
    });
  };
  bind("btn-estoque-mais-filtros", "estoque-filters-extra");
  bind("btn-contagem-mais-filtros", "contagem-filters-extra");
}

let configTab = "usuarios";

function switchConfigTab(tab) {
  const allowed = ["usuarios", "fornecedores", "nuvem", "cotacao"];
  configTab = allowed.includes(tab) ? tab : "usuarios";
  document.querySelectorAll("[data-config-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.configTab === configTab);
  });
  document.querySelectorAll("#view-configuracoes [data-config-panel]").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.configPanel !== configTab);
  });
  if (configTab === "nuvem") renderNuvem();
  else if (configTab === "cotacao") renderConfigCotacaoAgenda();
  else if (configTab === "fornecedores") renderFornecedores();
  else renderUsuarios();
}

function renderConfigCotacaoAgenda() {
  if (session?.role !== "admin") return;
  const a = ensureCotacaoAgenda();
  const autoEl = document.getElementById("cot-agenda-auto");
  const manualWrap = document.getElementById("cot-agenda-manual-wrap");
  const autoWrap = document.getElementById("cot-agenda-auto-wrap");
  const statusEl = document.getElementById("cot-agenda-status");
  if (autoEl) autoEl.checked = a.modo === "auto";
  if (manualWrap) manualWrap.classList.toggle("hidden", a.modo === "auto");
  if (autoWrap) autoWrap.classList.toggle("hidden", a.modo !== "auto");

  const modoManual = document.getElementById("cot-agenda-modo-manual");
  if (modoManual) {
    modoManual.value = a.modo === "travada" ? "travada" : "livre";
  }

  const iniDia = document.getElementById("cot-agenda-inicio-dia");
  const fimDia = document.getElementById("cot-agenda-fim-dia");
  const iniHora = document.getElementById("cot-agenda-inicio-hora");
  const fimHora = document.getElementById("cot-agenda-fim-hora");
  if (iniDia && !iniDia.options.length) {
    iniDia.innerHTML = opcoesDiaCotacao(a.inicioDia);
    fimDia.innerHTML = opcoesDiaCotacao(a.fimDia);
  } else if (iniDia) {
    iniDia.value = String(a.inicioDia);
    fimDia.value = String(a.fimDia);
  }
  if (iniHora) iniHora.value = a.inicioHora;
  if (fimHora) fimHora.value = a.fimHora;

  const st = labelStatusCotacaoAgenda();
  if (statusEl) {
    statusEl.textContent = st.detalhe;
    statusEl.classList.toggle("cot-agenda-status-ok", st.liberada);
    statusEl.classList.toggle("cot-agenda-status-lock", !st.liberada);
  }
}

function readCotacaoAgendaFromForm() {
  const a = ensureCotacaoAgenda();
  const autoOn = document.getElementById("cot-agenda-auto")?.checked;
  if (autoOn) {
    a.modo = "auto";
  } else {
    const manual = document.getElementById("cot-agenda-modo-manual")?.value;
    a.modo = manual === "travada" ? "travada" : "livre";
  }
  const iniDia = Number(document.getElementById("cot-agenda-inicio-dia")?.value);
  const fimDia = Number(document.getElementById("cot-agenda-fim-dia")?.value);
  a.inicioDia = Number.isFinite(iniDia) ? Math.min(6, Math.max(0, iniDia)) : a.inicioDia;
  a.fimDia = Number.isFinite(fimDia) ? Math.min(6, Math.max(0, fimDia)) : a.fimDia;
  a.inicioHora = normalizeHoraCotacao(
    document.getElementById("cot-agenda-inicio-hora")?.value,
    a.inicioHora
  );
  a.fimHora = normalizeHoraCotacao(document.getElementById("cot-agenda-fim-hora")?.value, a.fimHora);
  state.cotacaoAgenda = normalizeCotacaoAgenda(a);
  return state.cotacaoAgenda;
}

function saveCotacaoAgendaFromForm() {
  readCotacaoAgendaFromForm();
  scheduleSave();
  renderConfigCotacaoAgenda();
  if (document.getElementById("view-cotacao")?.classList.contains("active")) {
    renderCotacao();
  }
}

function renderMinhaSenha() {
  const hint = document.getElementById("config-conta-user");
  if (hint && session) {
    hint.textContent = `Usuário: ${session.id} — ${session.nome}`;
  }
}

function renderItensCotacaoFornecedor() {
  const listEl = document.getElementById("config-itens-cotacao-list");
  const wrap = document.getElementById("config-itens-cotacao-wrap");
  if (!listEl || !wrap) return;
  if (session?.role !== "fornecedor") {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const fid = session.fornecedorId;
  const busca = (document.getElementById("filter-itens-cotacao-busca")?.value || "").toLowerCase();
  const ocultos = new Set(getItensOcultosFornecedor(fid));
  const items = produtosAtivos()
    .filter((p) => !busca || p.nome.toLowerCase().includes(busca) || p.categoria.toLowerCase().includes(busca))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

  const nOcultos = ocultos.size;
  const meta = document.getElementById("config-itens-cotacao-meta");
  if (meta) {
    meta.textContent = nOcultos
      ? `${nOcultos} item(ns) oculto(s) — não aparecem na Cotação`
      : "Todos os itens ativos aparecem na Cotação";
  }

  listEl.innerHTML = items.length
    ? items
        .map((p) => {
          const checked = !ocultos.has(p.id);
          return `<label class="itens-cotacao-item">
            <input type="checkbox" data-pid="${escAttr(p.id)}" ${checked ? "checked" : ""} />
            <span class="itens-cotacao-item-body">
              <strong>${esc(p.nome)}</strong>
              <span>${esc(p.categoria)} · ${esc(p.unidade)}</span>
            </span>
          </label>`;
        })
        .join("")
    : '<p class="empty-state">Nenhum produto encontrado</p>';

  listEl.querySelectorAll('input[type="checkbox"][data-pid]').forEach((cb) => {
    cb.addEventListener("change", () => {
      setItemOcultoFornecedor(fid, cb.dataset.pid, !cb.checked);
      scheduleSave();
      renderItensCotacaoFornecedor();
    });
  });
}

function renderConfiguracoes() {
  const tabs = document.querySelector(".config-tabs");
  const panelConta = document.getElementById("config-panel-conta");

  if (session?.role === "fornecedor") {
    tabs?.classList.add("hidden");
    document.querySelectorAll("[data-config-panel]").forEach((p) => {
      p.classList.toggle("hidden", p.dataset.configPanel !== "conta");
    });
    const sub = document.getElementById("view-subtitle");
    if (sub) sub.textContent = "Senha e itens da cotação";
    renderMinhaSenha();
    renderItensCotacaoFornecedor();
    return;
  }

  tabs?.classList.remove("hidden");
  panelConta?.classList.add("hidden");
  document.getElementById("config-itens-cotacao-wrap")?.classList.add("hidden");
  const meta = VIEW_META.configuracoes;
  if (meta) {
    const sub = document.getElementById("view-subtitle");
    if (sub) sub.textContent = meta[1];
  }
  switchConfigTab(configTab);
}

/* ── Dashboard ── */
function renderDashboard() {
  syncProducaoEMinimosFabrica();
  const ativos = produtosAtivos();
  let baixo = 0;
  let pendCot = 0;
  let aComprar = 0;
  let produzir = 0;

  const lojasCheck = session.role === "loja" ? getLojas().filter((l) => l.id === session.lojaId) : getLojas();
  const baixoList = listBaixoMinimo(lojasCheck.map((l) => l.id));
  baixo = baixoList.length;
  const baixoCentral = countBaixoMinimo("central");
  const emergPendentes = getSolicitacoesEmergencia().filter((s) => s.status === "pendente").length;

  ativos.forEach((p) => {
    const t = qtdeComprarProduto(p.id);
    aComprar += t.comprar;
    if (state.producao[p.id]?.lista === "PRODUZIR") produzir++;
  });

  if (session.role === "fornecedor") {
    const fid = session.fornecedorId;
    const ocultos = new Set(getItensOcultosFornecedor(fid));
    ativos.forEach((p) => {
      if (ocultos.has(p.id)) return;
      const c = state.cotacoes[fid]?.[p.id];
      if (c && Number(c.qtde) > 0 && (String(c.status).toUpperCase() !== "OK" || !Number(c.preco))) pendCot++;
    });
  } else if (session.role === "admin") {
    getFornecedores().forEach((f) => {
      ativos.forEach((p) => {
        const c = state.cotacoes[f.id]?.[p.id];
        if (c && Number(c.qtde) > 0 && String(c.status).toUpperCase() !== "OK") pendCot++;
      });
    });
  }

  const showCentralAlert =
    (session.role === "admin" || (session.role === "loja" && session.lojaId === "central")) && baixoCentral > 0;
  const showEmergAlert = canManageEmergencia() && emergPendentes > 0;
  const { vencidos: lotesVencidos, proximos: lotesProximos, dias: diasVal } = listValidadesAlerta();
  const showVencidos = session.role !== "fornecedor" && lotesVencidos.length > 0;
  const showProximos = session.role !== "fornecedor" && lotesProximos.length > 0;
  const banner = document.getElementById("dash-alertas");
  if (banner) {
    const parts = [];
    if (showVencidos) {
      parts.push(
        `<div class="alert-banner alert-danger alert-banner-stack" role="status">
          <div class="alert-banner-head">
            <strong>${lotesVencidos.length} item(ns) vencido(s)</strong>
            <span>Lotes com validade anterior a hoje. Remova ou ajuste no Estoque.</span>
            <button class="btn btn-ghost btn-sm" type="button" data-goto="estoque-validade">Ver estoque</button>
          </div>
          ${renderValidadeAlertList(lotesVencidos)}
        </div>`
      );
    }
    if (showProximos) {
      parts.push(
        `<div class="alert-banner alert-warn alert-banner-stack" role="status">
          <div class="alert-banner-head">
            <strong>${lotesProximos.length} próximo(s) do vencimento (${diasVal} dias)</strong>
            <span>Lotes que vencem até ${formatDateBR(addDaysISO(hojeLocalISO(), diasVal))}.</span>
            <button class="btn btn-ghost btn-sm" type="button" data-goto="estoque-validade">Ver estoque</button>
          </div>
          ${renderValidadeAlertList(lotesProximos)}
        </div>`
      );
    }
    if (showCentralAlert) {
      parts.push(
        `<div class="alert-banner alert-danger" role="status">
          <strong>Estoque Central abaixo do mínimo</strong>
          <span>${baixoCentral} item(ns) com saldo &lt; mínimo. Revise Contagem/Estoque do Central.</span>
          <button class="btn btn-ghost btn-sm" type="button" data-goto="estoque-central">Ver estoque</button>
        </div>`
      );
    }
    if (showEmergAlert) {
      parts.push(
        `<div class="alert-banner alert-warn" role="status">
          <strong>Solicitações de emergência</strong>
          <span>${emergPendentes} pedido(s) pendente(s). Ao atender, escolha a origem do estoque (Central ou outra loja).</span>
          <button class="btn btn-ghost btn-sm" type="button" data-goto="emergencia">Atender</button>
        </div>`
      );
    }
    banner.innerHTML = parts.join("");
    banner.classList.toggle("hidden", !parts.length);
    banner.querySelectorAll("[data-goto]").forEach((btn) => {
      btn.addEventListener("click", () => handleDashGoto(btn.dataset.goto, btn));
    });
    banner.querySelectorAll("[data-goto-estoque]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        gotoEstoqueValidade(btn.dataset.gotoEstoque, btn.dataset.produtoBusca || "", btn.dataset.produtoId || "", {
          openLotes: btn.dataset.openLotes === "1",
        });
      });
    });
  }

  const kpis = [];
  if (session.role !== "fornecedor") {
    kpis.push(
      `<button type="button" class="kpi-card kpi-clickable" data-goto="estoque-baixo"><p class="kpi-label">Abaixo do mínimo</p><p class="kpi-value kpi-danger">${baixo}</p></button>`
    );
    if (lotesVencidos.length) {
      kpis.push(
        `<button type="button" class="kpi-card kpi-card-alert kpi-clickable" data-goto="estoque-validade"><p class="kpi-label">Lotes vencidos</p><p class="kpi-value kpi-danger">${lotesVencidos.length}</p></button>`
      );
    }
    if (lotesProximos.length) {
      kpis.push(
        `<button type="button" class="kpi-card kpi-clickable" data-goto="estoque-validade"><p class="kpi-label">Próx. vencimento (${diasVal}d)</p><p class="kpi-value kpi-warn">${lotesProximos.length}</p></button>`
      );
    }
    if (session.role === "admin" || session.lojaId === "central") {
      kpis.push(
        `<button type="button" class="kpi-card kpi-card-alert kpi-clickable" data-goto="estoque-central"><p class="kpi-label">Central abaixo do mín.</p><p class="kpi-value kpi-danger">${baixoCentral}</p></button>`
      );
      kpis.push(
        `<button type="button" class="kpi-card${emergPendentes ? " kpi-card-alert" : ""} kpi-clickable" data-goto="emergencia"><p class="kpi-label">Emergências pendentes</p><p class="kpi-value ${emergPendentes ? "kpi-warn" : ""}">${emergPendentes}</p></button>`
      );
    }
    if (can("producao")) {
      kpis.push(
        `<button type="button" class="kpi-card kpi-clickable" data-goto="producao"><p class="kpi-label">Itens a produzir</p><p class="kpi-value kpi-warn">${produzir}</p></button>`
      );
    } else {
      kpis.push(`<article class="kpi-card"><p class="kpi-label">Itens a produzir</p><p class="kpi-value kpi-warn">${produzir}</p></article>`);
    }
  }
  if (session.role !== "loja") {
    kpis.push(
      `<button type="button" class="kpi-card kpi-clickable" data-goto="cotacao"><p class="kpi-label">Cotações pendentes</p><p class="kpi-value kpi-warn">${pendCot}</p></button>`
    );
  }
  if (session.role === "admin") {
    const vg = valorEstoqueGeral();
    kpis.push(`<article class="kpi-card"><p class="kpi-label">Qtde a comprar (Σ)</p><p class="kpi-value">${formatNum(aComprar)}</p></article>`);
    kpis.push(
      `<article class="kpi-card"><p class="kpi-label">Valor estoque (geral)</p><p class="kpi-value">${formatMoney(vg.valor)}</p></article>`
    );
    kpis.push(`<article class="kpi-card"><p class="kpi-label">Produtos ativos</p><p class="kpi-value">${ativos.length}</p></article>`);
  }
  if (session.role === "loja") {
    const vv = valorEstoqueLoja(session.lojaId);
    kpis.push(`<article class="kpi-card"><p class="kpi-label">Sua loja</p><p class="kpi-value" style="font-size:1rem">${esc(session.nome)}</p></article>`);
    kpis.push(
      `<button type="button" class="kpi-card kpi-clickable" data-goto="estoque"><p class="kpi-label">Valor do seu estoque</p><p class="kpi-value">${formatMoney(vv.valor)}</p></button>`
    );
    if (isLojaOperacional(session.lojaId)) {
      const minhasPend = getSolicitacoesEmergencia().filter(
        (s) => s.lojaId === session.lojaId && (s.status === "pendente" || s.status === "enviada")
      ).length;
      kpis.push(
        `<button type="button" class="kpi-card kpi-clickable" data-goto="emergencia"><p class="kpi-label">Seus pedidos urgentes</p><p class="kpi-value ${minhasPend ? "kpi-warn" : ""}">${minhasPend}</p></button>`
      );
    }
  }
  if (session.role === "fornecedor") {
    kpis.push(`<article class="kpi-card"><p class="kpi-label">Seu perfil</p><p class="kpi-value" style="font-size:1rem">${esc(session.nome)}</p></article>`);
  }
  document.getElementById("dash-kpis").innerHTML = kpis.join("");
  document.querySelectorAll("#dash-kpis [data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => handleDashGoto(btn.dataset.goto, btn));
  });

  const semPrecoToolbar = document.getElementById("dash-sem-preco-toolbar");
  const btnSemPreco = document.getElementById("btn-baixar-itens-sem-preco");
  if (semPrecoToolbar && btnSemPreco) {
    const showSemPreco = canBaixarItensSemPreco();
    semPrecoToolbar.classList.toggle("hidden", !showSemPreco);
    if (showSemPreco) {
      const nSem = itensSemPreco().length;
      btnSemPreco.textContent = nSem
        ? `Baixar ${nSem} sem preço`
        : "Baixar itens sem preço";
    }
  }

  const panelBaixo = document.getElementById("dash-baixo-minimo");
  if (panelBaixo) {
    const header = panelBaixo.closest(".panel")?.querySelector(".panel-header h3");
    if (header) {
      header.textContent =
        session.role === "admin" || session.lojaId === "central"
          ? `Abaixo do mínimo${baixoCentral ? ` · Central: ${baixoCentral}` : ""}`
          : "Abaixo do mínimo";
    }
  }
  document.getElementById("dash-baixo-minimo").innerHTML = baixoList.length
    ? baixoList
        .slice(0, 12)
        .map(
          (x) =>
            `<button type="button" class="list-item list-item-btn${x.central ? " list-item-alert" : ""}" data-goto="estoque-baixo" data-loja-id="${esc(x.lojaId)}" data-produto-busca="${esc(x.nome)}"><strong>${esc(x.nome)}</strong><span>${esc(x.loja)} · ${formatNum(x.saldo)} / mín ${formatNum(x.min)}</span></button>`
        )
        .join("")
    : '<p class="empty-state">Nenhum item abaixo do mínimo</p>';
  document.querySelectorAll("#dash-baixo-minimo [data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const lid = btn.dataset.lojaId || "";
      const busca = btn.dataset.produtoBusca || "";
      gotoEstoqueBaixo(lid);
      const buscaEl = document.getElementById("filter-estoque-busca");
      if (buscaEl && busca) buscaEl.value = busca;
      if (can("estoque")) renderEstoque();
    });
  });

  const pendList = [];
  if (session.role === "fornecedor") {
    const fid = session.fornecedorId;
    const ocultos = new Set(getItensOcultosFornecedor(fid));
    ativos.forEach((p) => {
      if (ocultos.has(p.id)) return;
      const c = state.cotacoes[fid]?.[p.id];
      if (c && Number(c.qtde) > 0 && (String(c.status).toUpperCase() !== "OK" || !Number(c.preco))) {
        pendList.push({ nome: p.nome, extra: `qtde ${formatNum(c.qtde)}` });
      }
    });
  } else if (session.role === "admin") {
    getFornecedores().forEach((f) => {
      let n = 0;
      ativos.forEach((p) => {
        const c = state.cotacoes[f.id]?.[p.id];
        if (c && Number(c.qtde) > 0 && String(c.status).toUpperCase() !== "OK") n++;
      });
      if (n) pendList.push({ nome: f.nome, extra: `${n} pendentes` });
    });
  }
  document.getElementById("dash-cotacoes").innerHTML = pendList.length
    ? pendList
        .slice(0, 12)
        .map((x) => {
          const clickable = session.role !== "loja";
          return clickable
            ? `<button type="button" class="list-item list-item-btn" data-goto="cotacao"><strong>${esc(x.nome)}</strong><span>${esc(x.extra)}</span></button>`
            : `<div class="list-item"><strong>${esc(x.nome)}</strong><span>${esc(x.extra)}</span></div>`;
        })
        .join("")
    : '<p class="empty-state">Sem pendências de cotação</p>';
  document.querySelectorAll("#dash-cotacoes [data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => handleDashGoto(btn.dataset.goto, btn));
  });

  const prodList = ativos
    .filter((p) => state.producao[p.id]?.lista === "PRODUZIR")
    .map((p) => {
      const pr = state.producao[p.id];
      const falta = Math.max(0, Number(pr.totalProduzir) - Number(pr.totalProduzido));
      return { nome: p.nome, falta, total: pr.totalProduzir };
    })
    .sort((a, b) => b.falta - a.falta);

  const prodClickable = can("producao");
  document.getElementById("dash-producao").innerHTML =
    session.role === "fornecedor"
      ? '<p class="empty-state">Produção visível para admin e fábrica</p>'
      : prodList.length
        ? prodList
            .slice(0, 15)
            .map(
              (x) =>
                prodClickable
                  ? `<button type="button" class="list-item list-item-btn" data-goto="producao"><strong>${esc(x.nome)}</strong><span>falta ${formatNum(x.falta)} / ${formatNum(x.total)}</span></button>`
                  : `<div class="list-item"><strong>${esc(x.nome)}</strong><span>falta ${formatNum(x.falta)} / ${formatNum(x.total)}</span></div>`
            )
            .join("")
        : '<p class="empty-state">Nada na lista PRODUZIR</p>';
  document.querySelectorAll("#dash-producao [data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => handleDashGoto(btn.dataset.goto, btn));
  });
}

function renderMinimoBanner(containerId, lojaId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (lojaId !== "central") {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }
  const n = countBaixoMinimo("central");
  if (!n) {
    el.innerHTML = "";
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = `<div class="alert-banner alert-danger" role="status">
    <strong>Central abaixo do mínimo</strong>
    <span>${n} item(ns) com saldo menor que o mínimo. Use o filtro “Abaixo do mínimo”.</span>
  </div>`;
}

/* ── Contagem (loja) — item a item + listagem + validação ── */
function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function foiContadoHoje(entry) {
  return !!(entry?.contadoEm && String(entry.contadoEm).slice(0, 10) === hojeISO());
}

function contagemLojaId() {
  if (session?.role === "loja") return session.lojaId;
  return document.getElementById("filter-contagem-loja")?.value || getLojas()[0]?.id || "central";
}

function setContagemSaldo(lojaId, produtoId, valor, marcarContado = true) {
  const entry = ensureEstoque(lojaId, produtoId);
  const de = Number(entry.saldo) || 0;
  const para = Math.max(0, Number(valor) || 0);
  entry.saldo = para;
  if (marcarContado) entry.contadoEm = new Date().toISOString();
  pushMovimento({
    lojaId,
    produtoId,
    de,
    para,
    motivo: "contagem",
    nota: marcarContado ? "Contagem" : "Contagem (ajuste)",
    tipo: "contagem",
  });
  scheduleSave();
}

/* Validação de quantidade por unidade */
function normalizeUnidade(unidade) {
  return String(unidade || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, "");
}

function isUnidadeInteira(unidade) {
  const u = normalizeUnidade(unidade);
  if (!u) return true;
  const pesoOuVol = /^(kg|g|gr|grama|gramas|quilo|quilos|l|lt|litro|litros|ml|mililitro|mililitros)$/;
  if (pesoOuVol.test(u)) return false;
  const inteiras =
    /^(un|und|unid|unidade|unidades|pc|pcs|peca|pecas|cx|caixa|caixas|pct|pacote|pacotes|fd|fardo|fardos|dz|duzia|duzias|bd|balde|baldes|sc|saco|sacos|par|pares|kit|kits|rolo|rolos|bandeja|bandejas|lata|latas|garrafa|garrafas)$/;
  return inteiras.test(u) || u.startsWith("un");
}

function isUnidadePeso(unidade) {
  const u = normalizeUnidade(unidade);
  return /^(kg|g|gr|grama|gramas|quilo|quilos)$/.test(u);
}

function maxQtdePorUnidade(unidade, lojaId) {
  const u = normalizeUnidade(unidade);
  const isCentralish = lojaId === "fabrica" || lojaId === "central";
  if (u === "g" || u === "gr" || u.startsWith("grama")) return isCentralish ? 50000 : 20000;
  if (isUnidadePeso(unidade)) return isCentralish ? 2000 : 500;
  if (/^(l|lt|litro|litros)$/.test(u)) return isCentralish ? 2000 : 500;
  if (/^ml/.test(u)) return isCentralish ? 50000 : 20000;
  return isCentralish ? 20000 : 5000;
}

/** Interpreta raw digitado; detecta abuso de milhar (ex.: 10.000). */
function parseQtyInput(raw, unidade) {
  const s = String(raw ?? "").trim().replace(/\s/g, "");
  if (s === "") return { ok: false, value: 0, error: "Informe a quantidade." };

  // Padrão milhar BR/US sem decimais reais: 10.000 ou 10,000
  const milhar = /^(\d{1,3})([.,]\d{3})+$/;
  if (milhar.test(s) && isUnidadePeso(unidade)) {
    return {
      ok: false,
      value: 0,
      error:
        "Valor suspeito demais para kg (ex.: 10.000 = 10 mil kg). Use ponto só para decimais (ex.: 10,5 → digite 10.5) e valores reais da contagem.",
    };
  }
  if (milhar.test(s) && isUnidadeInteira(unidade)) {
    const digits = s.replace(/[.,]/g, "");
    const n = Number(digits);
    if (!Number.isFinite(n)) return { ok: false, value: 0, error: "Quantidade inválida." };
    return { ok: true, value: n, error: "", warnMilhar: true };
  }

  // Vírgula decimal BR: "10,5" → 10.5
  let normalized = s;
  if (/^\d+,\d+$/.test(s)) normalized = s.replace(",", ".");
  else if (/^\d+\.\d+$/.test(s)) normalized = s;
  else if (/^\d+$/.test(s)) normalized = s;
  else {
    // mistura estranha
    const nTry = Number(s.replace(",", "."));
    if (!Number.isFinite(nTry)) return { ok: false, value: 0, error: "Quantidade inválida." };
    normalized = String(nTry);
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return { ok: false, value: 0, error: "Quantidade inválida." };
  if (n < 0) return { ok: false, value: 0, error: "Quantidade não pode ser negativa." };
  return { ok: true, value: n, error: "" };
}

function validarQtde(valorOuRaw, unidade, { lojaId = "", softConfirm = true } = {}) {
  const parsed =
    typeof valorOuRaw === "number"
      ? { ok: Number.isFinite(valorOuRaw), value: Number(valorOuRaw) || 0, error: Number.isFinite(valorOuRaw) ? "" : "Quantidade inválida." }
      : parseQtyInput(valorOuRaw, unidade);
  if (!parsed.ok) return { ok: false, value: 0, error: parsed.error };

  let value = parsed.value;
  if (isUnidadeInteira(unidade)) {
    if (!Number.isInteger(value) && Math.abs(value - Math.round(value)) > 1e-9) {
      return { ok: false, value: 0, error: "Unitário não aceita fração. Use só números inteiros (0, 1, 2…)." };
    }
    value = Math.round(value);
  } else {
    value = Math.round(value * 1000) / 1000;
  }

  const max = maxQtdePorUnidade(unidade, lojaId);
  if (value > max) {
    const label = isUnidadePeso(unidade) ? "kg" : normalizeUnidade(unidade) || "un";
    return {
      ok: false,
      value: 0,
      error: `Valor absurdo demais (${formatNum(value)} ${label}). Máximo aceito aqui: ${formatNum(max)}. Confira se não digitou milhar por engano.`,
    };
  }

  if (softConfirm && isUnidadePeso(unidade) && value > 200) {
    if (
      !confirm(
        `Confirma ${formatNum(value)} kg neste item?\n\nValores altos em kg costumam ser erro de digitação (ex.: 1000 em vez de 10).`
      )
    ) {
      return { ok: false, value: 0, error: "Quantidade não confirmada." };
    }
  }

  return { ok: true, value: Math.max(0, value), error: "" };
}

function applyValidatedQty(inputEl, unidade, lojaId, { alertOnError = true } = {}) {
  const raw = inputEl?.dataset?.rawQty != null && inputEl.dataset.rawQty !== "" ? inputEl.dataset.rawQty : inputEl?.value;
  const v = validarQtde(raw, unidade, { lojaId, softConfirm: true });
  if (!v.ok) {
    if (alertOnError && v.error) alert(v.error);
    return null;
  }
  if (inputEl) inputEl.value = v.value;
  return v.value;
}

function bindQtyRawCapture(inputEl) {
  if (!inputEl) return;
  inputEl.addEventListener("input", () => {
    inputEl.dataset.rawQty = inputEl.value;
  });
}

let contagemPanel = "start"; // start | flow | lista
let contagemFlowIdx = 0;
let contagemFlowIds = [];

function setContagemPanel(panel) {
  contagemPanel = panel;
  document.getElementById("contagem-start-panel")?.classList.toggle("hidden", panel !== "start");
  document.getElementById("contagem-flow-panel")?.classList.toggle("hidden", panel !== "flow");
  document.getElementById("contagem-lista-panel")?.classList.toggle("hidden", panel !== "lista");
}

function produtosContagemLoja() {
  return produtosDaLoja(contagemLojaId(), {
    incluirOcultos: document.getElementById("filter-contagem-ocultos")?.checked === true,
  });
}

function contagemProgresso() {
  const lojaId = contagemLojaId();
  const produtos = produtosContagemLoja();
  let feitos = 0;
  produtos.forEach((p) => {
    if (foiContadoHoje(ensureEstoque(lojaId, p.id))) feitos += 1;
  });
  return { feitos, total: produtos.length, produtos };
}

function iniciarContagem({ zerar = true } = {}) {
  const lojaId = contagemLojaId();
  const produtos = produtosContagemLoja();
  if (!produtos.length) {
    alert("Nenhum item visível para esta loja.");
    return;
  }
  if (zerar) {
    if (
      !confirm(
        "Iniciar contagem?\n\nIsso ZERA os saldos desta loja e limpa a marcação de “contado hoje”, para você contar item a item do zero."
      )
    ) {
      return;
    }
    produtos.forEach((p) => {
      const e = ensureEstoque(lojaId, p.id);
      e.saldo = 0;
      e.contadoEm = "";
    });
    scheduleSave();
  }
  contagemFlowIds = produtos.map((p) => p.id);
  contagemFlowIdx = zerar
    ? 0
    : Math.max(
        0,
        contagemFlowIds.findIndex((id) => !foiContadoHoje(ensureEstoque(lojaId, id)))
      );
  if (contagemFlowIdx < 0) contagemFlowIdx = 0;
  setContagemPanel("flow");
  renderContagemItemAtual();
}

function renderContagemItemAtual() {
  const lojaId = contagemLojaId();
  const card = document.getElementById("contagem-item-card");
  const errEl = document.getElementById("contagem-flow-erro");
  if (errEl) {
    errEl.textContent = "";
    errEl.classList.add("hidden");
  }
  if (!card || !contagemFlowIds.length) return;

  const { feitos, total } = contagemProgresso();
  document.getElementById("contagem-flow-titulo").textContent = lojaNome(lojaId);
  document.getElementById("contagem-flow-progress").textContent = `${feitos} / ${total} contados · item ${Math.min(contagemFlowIdx + 1, contagemFlowIds.length)}/${contagemFlowIds.length}`;
  document.getElementById("contagem-flow-progress-fill").style.width = `${Math.min(100, (feitos / (total || 1)) * 100)}%`;

  if (contagemFlowIdx >= contagemFlowIds.length) {
    card.innerHTML = `
      <div class="contagem-item-done">
        <h3>Contagem concluída</h3>
        <p class="toolbar-hint">${feitos} itens contados hoje nesta loja.</p>
        <button class="btn btn-block btn-lg" id="btn-contagem-fim-lista" type="button">Ver listagem</button>
        <button class="btn btn-ghost btn-block" id="btn-contagem-fim-inicio" type="button">Voltar ao início</button>
      </div>`;
    document.getElementById("btn-contagem-fim-lista")?.addEventListener("click", () => {
      setContagemPanel("lista");
      renderContagemLista();
    });
    document.getElementById("btn-contagem-fim-inicio")?.addEventListener("click", () => {
      setContagemPanel("start");
      renderContagem();
    });
    return;
  }

  const pid = contagemFlowIds[contagemFlowIdx];
  const p = getProduto(pid);
  const e = ensureEstoque(lojaId, pid);
  const inteira = isUnidadeInteira(p?.unidade);

  card.innerHTML = `
    <p class="contagem-item-cat">${esc(p?.categoria || "")} · ${esc(p?.unidade || "")}</p>
    <h3 class="contagem-item-nome">${esc(p?.nome || pid)}</h3>
    <p class="contagem-meta">mín ${formatNum(e.minimo)}${foiContadoHoje(e) ? " · ✓ já contado hoje" : ""}</p>
    <div class="contagem-controls contagem-qty">
      <button class="qty-btn" data-contagem-delta="-1" type="button" aria-label="Diminuir">−</button>
      <input class="qty-input" id="contagem-qty-input" inputmode="${inteira ? "numeric" : "decimal"}" type="text" enterkeyhint="done" autocomplete="off" value="${e.saldo ?? 0}" />
      <button class="qty-btn" data-contagem-delta="1" type="button" aria-label="Aumentar">+</button>
    </div>
    <div class="contagem-item-actions">
      <button class="btn btn-block btn-lg" id="btn-contagem-ok" type="button">OK — próximo</button>
    </div>`;

  const input = document.getElementById("contagem-qty-input");
  bindQtyRawCapture(input);
  card.querySelectorAll("[data-contagem-delta]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = Number(btn.dataset.contagemDelta);
      const cur = Number(input.value) || 0;
      const next = Math.max(0, Math.round((cur + d) * 1000) / 1000);
      input.value = inteira ? Math.round(next) : next;
      input.dataset.rawQty = input.value;
      input.focus();
    });
  });

  const confirmar = (forceZero = false) => {
    const raw = forceZero ? "0" : input?.dataset?.rawQty != null && input.dataset.rawQty !== "" ? input.dataset.rawQty : input?.value;
    const v = validarQtde(raw, p?.unidade, { lojaId, softConfirm: !forceZero });
    if (!v.ok) {
      if (errEl) {
        errEl.textContent = v.error;
        errEl.classList.remove("hidden");
      } else if (v.error) alert(v.error);
      return;
    }
    setContagemSaldo(lojaId, pid, v.value, true);
    contagemFlowIdx += 1;
    renderContagemItemAtual();
  };

  document.getElementById("btn-contagem-ok")?.addEventListener("click", () => confirmar(false));
  input?.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      confirmar(false);
    }
  });
  setTimeout(() => {
    input?.focus();
    input?.select();
  }, 50);

  card._contagemPular = () => confirmar(true);
}

function renderContagemLista() {
  const lojaId = contagemLojaId();
  const loja = getAllLojas().find((l) => l.id === lojaId);
  const titulo = document.getElementById("contagem-lista-titulo");
  if (titulo) titulo.textContent = loja?.nome || "Listagem";
  renderMinimoBanner("contagem-alerta-minimo", lojaId);

  const busca = document.getElementById("filter-contagem-busca")?.value.toLowerCase() || "";
  const cat = document.getElementById("filter-contagem-categoria")?.value || "";
  const status = document.getElementById("filter-contagem-status")?.value || "pendentes";

  const ativos = produtosContagemLoja();
  let contados = 0;
  ativos.forEach((p) => {
    if (foiContadoHoje(ensureEstoque(lojaId, p.id))) contados++;
  });
  const total = ativos.length || 1;
  const nVis = idsProdutosVisiveisLoja(lojaId)?.length;
  const prog = document.getElementById("contagem-progress");
  const fill = document.getElementById("contagem-progress-fill");
  if (prog) {
    prog.textContent = `${contados} / ${ativos.length} contados hoje${nVis && !document.getElementById("filter-contagem-ocultos")?.checked ? ` · ${nVis} itens desta loja` : ""}`;
  }
  if (fill) fill.style.width = `${Math.min(100, (contados / total) * 100)}%`;

  const cats = ["", ...categorias()];
  const catsEl = document.getElementById("contagem-cats");
  if (catsEl) {
    catsEl.innerHTML = cats
      .map((c) => {
        const label = c || "Todas";
        const active = cat === c ? "active" : "";
        return `<button class="cat-chip ${active}" data-cat="${escAttr(c)}" type="button">${esc(label)}</button>`;
      })
      .join("");
    catsEl.querySelectorAll("[data-cat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById("filter-contagem-categoria").value = btn.dataset.cat;
        renderContagemLista();
      });
    });
  }

  const rows = ativos
    .filter((p) => !cat || p.categoria === cat)
    .filter((p) => !busca || p.nome.toLowerCase().includes(busca) || p.categoria.toLowerCase().includes(busca))
    .map((p) => {
      const e = ensureEstoque(lojaId, p.id);
      return { p, e, contado: foiContadoHoje(e), st: estoqueStatus(e) };
    })
    .filter((x) => {
      if (status === "pendentes") return !x.contado;
      if (status === "contados") return x.contado;
      if (status === "baixo") return x.st === "baixo";
      return true;
    });

  const list = document.getElementById("contagem-list");
  if (!list) return;
  if (!rows.length) {
    list.innerHTML = '<p class="empty-state">Nenhum item neste filtro. Troque para “Todos” ou outra categoria.</p>';
    return;
  }

  list.innerHTML = rows
    .map(({ p, e, contado, st }) => {
      const cls = [contado ? "contado" : "", st === "baixo" ? "baixo" : ""].filter(Boolean).join(" ");
      const fabReceita = lojaId === "fabrica" && hasReceitaFabrica(p.id);
      const modo = fabReceita ? minimoModoFabrica(e, p.id) : null;
      const isFormula = modo === "formula";
      const canModo = fabReceita && canEditMinimoFabrica();
      const inteira = isUnidadeInteira(p.unidade);
      const modoControls = fabReceita
        ? `<div class="min-modo-controls">
            ${badgeMinimoModoHtml(modo)}
            ${
              canModo
                ? `<select class="min-modo-select" data-min-modo title="Modo do estoque mínimo">
                     <option value="formula" ${isFormula ? "selected" : ""}>Fórmula</option>
                     <option value="fixo" ${!isFormula ? "selected" : ""}>Fixo</option>
                   </select>
                   <button class="btn btn-ghost btn-sm" data-min-cfg type="button" title="${escAttr(descricaoReceitaFabrica(p.id) || "Editar fórmula")}">Fórmula…</button>`
                : ""
            }
          </div>`
        : "";
      return `<article class="contagem-card ${cls}" data-pid="${p.id}">
        <div class="contagem-card-top">
          <div>
            <strong>${esc(p.nome)}</strong>
            <div class="contagem-meta">${esc(p.categoria)} · ${esc(p.unidade)}${contado ? " · ✓ contado hoje" : ""}${isFormula ? " · lilás" : ""}</div>
          </div>
          <span class="badge badge-${st === "baixo" ? "baixo" : contado ? "ok" : "falta"}">${st === "baixo" ? "Baixo" : contado ? "OK" : "Pendente"}</span>
        </div>
        <div class="contagem-min-row">
          <label>mínimo
            <input class="qty-input qty-min ${isFormula ? "cell-lilas" : ""}" data-min inputmode="decimal" step="any" type="number" value="${e.minimo ?? 0}" ${isFormula ? "readonly title=\"Calculado por fórmula — mude para Fixo para editar\"" : 'title="Estoque mínimo"'} />
          </label>
          ${modoControls}
        </div>
        <div class="contagem-controls">
          <button class="qty-btn" data-delta="-1" type="button" aria-label="Diminuir">−</button>
          <input class="qty-input" data-qty inputmode="${inteira ? "numeric" : "decimal"}" type="text" enterkeyhint="done" autocomplete="off" value="${e.saldo ?? 0}" />
          <button class="qty-btn" data-delta="1" type="button" aria-label="Aumentar">+</button>
        </div>
        <p class="qty-error hidden" data-qty-error></p>
        <div class="contagem-actions">
          <button class="btn btn-ghost" data-zero type="button">Zerar</button>
          <button class="btn" data-confirm type="button">✓ Confirmar</button>
        </div>
      </article>`;
    })
    .join("");

  list.querySelectorAll(".contagem-card").forEach((card) => {
    const pid = card.dataset.pid;
    const p = getProduto(pid);
    const input = card.querySelector("[data-qty]");
    const minInput = card.querySelector("[data-min]");
    const errEl = card.querySelector("[data-qty-error]");
    bindQtyRawCapture(input);

    const showErr = (msg) => {
      if (!errEl) {
        if (msg) alert(msg);
        return;
      }
      if (msg) {
        errEl.textContent = msg;
        errEl.classList.remove("hidden");
      } else {
        errEl.textContent = "";
        errEl.classList.add("hidden");
      }
    };

    const salvarQty = ({ softConfirm = true } = {}) => {
      const raw = input.dataset.rawQty != null && input.dataset.rawQty !== "" ? input.dataset.rawQty : input.value;
      const v = validarQtde(raw, p?.unidade, { lojaId, softConfirm });
      if (!v.ok) {
        showErr(v.error);
        return false;
      }
      showErr("");
      input.value = v.value;
      setContagemSaldo(lojaId, pid, v.value, true);
      return true;
    };

    minInput?.addEventListener("change", () => {
      const entryNow = ensureEstoque(lojaId, pid);
      const emFormula =
        lojaId === "fabrica" && hasReceitaFabrica(pid) && minimoModoFabrica(entryNow, pid) === "formula";
      if (emFormula) {
        // Não grava override silencioso: recarrega o valor da fórmula
        minInput.value = entryNow.minimo ?? 0;
        return;
      }
      setMinimoEstoque(lojaId, pid, minInput.value, {
        manualOverride: lojaId === "fabrica" && hasReceitaFabrica(pid),
      });
      renderContagemLista();
    });

    card.querySelector("[data-min-modo]")?.addEventListener("change", (ev) => {
      const next = ev.target.value;
      const done = setMinimoModoFabrica(pid, next);
      if (!done) {
        const e = ensureEstoque(lojaId, pid);
        ev.target.value = minimoModoFabrica(e, pid);
        return;
      }
      renderContagemLista();
    });

    card.querySelector("[data-min-cfg]")?.addEventListener("click", () => {
      openMinimoFabricaModal(pid);
    });

    card.querySelectorAll("[data-delta]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const delta = Number(btn.dataset.delta);
        const cur = Number(input.value) || 0;
        const inteira = isUnidadeInteira(p?.unidade);
        const next = Math.max(0, Math.round((cur + delta) * 1000) / 1000);
        input.value = inteira ? Math.round(next) : next;
        input.dataset.rawQty = input.value;
        if (salvarQty({ softConfirm: false })) {
          if (document.getElementById("filter-contagem-status").value === "pendentes") {
            card.classList.add("contado");
          }
          updateContagemProgressOnly(lojaId);
        }
      });
    });

    input.addEventListener("change", () => {
      if (salvarQty({ softConfirm: true })) updateContagemProgressOnly(lojaId);
    });

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        if (!salvarQty({ softConfirm: true })) return;
        const cards = [...list.querySelectorAll(".contagem-card")];
        const idx = cards.indexOf(card);
        const next = cards[idx + 1]?.querySelector("[data-qty]");
        if (next) next.focus();
        else updateContagemProgressOnly(lojaId);
      }
    });

    card.querySelector("[data-zero]").addEventListener("click", () => {
      input.value = 0;
      input.dataset.rawQty = "0";
      setContagemSaldo(lojaId, pid, 0, true);
      showErr("");
      card.classList.add("contado");
      updateContagemProgressOnly(lojaId);
    });

    card.querySelector("[data-confirm]").addEventListener("click", () => {
      if (!salvarQty({ softConfirm: true })) return;
      card.classList.add("contado");
      updateContagemProgressOnly(lojaId);
      const statusFilter = document.getElementById("filter-contagem-status").value;
      if (statusFilter === "pendentes") {
        card.style.opacity = "0.45";
        setTimeout(() => {
          if (document.getElementById("filter-contagem-status").value === "pendentes") {
            card.remove();
            if (!list.querySelector(".contagem-card")) renderContagemLista();
          }
        }, 280);
      } else {
        renderContagemLista();
      }
    });
  });
}

function updateContagemProgressOnly(lojaId) {
  const ativos = produtosDaLoja(lojaId, {
    incluirOcultos: document.getElementById("filter-contagem-ocultos")?.checked === true,
  });
  let contados = 0;
  ativos.forEach((p) => {
    if (foiContadoHoje(ensureEstoque(lojaId, p.id))) contados++;
  });
  const total = ativos.length || 1;
  const prog = document.getElementById("contagem-progress");
  const fill = document.getElementById("contagem-progress-fill");
  if (prog) prog.textContent = `${contados} / ${ativos.length} contados hoje`;
  if (fill) fill.style.width = `${Math.min(100, (contados / total) * 100)}%`;
  const flowProg = document.getElementById("contagem-flow-progress");
  const flowFill = document.getElementById("contagem-flow-progress-fill");
  if (flowProg && contagemPanel === "flow") {
    flowProg.textContent = `${contados} / ${ativos.length} contados · item ${Math.min(contagemFlowIdx + 1, contagemFlowIds.length || 1)}/${contagemFlowIds.length || ativos.length}`;
  }
  if (flowFill && contagemPanel === "flow") {
    flowFill.style.width = `${Math.min(100, (contados / total) * 100)}%`;
  }
}

function renderContagem() {
  const lojaId = contagemLojaId();
  const loja = getAllLojas().find((l) => l.id === lojaId);
  const nomeEl = document.getElementById("contagem-loja-nome");
  if (nomeEl) nomeEl.textContent = loja?.nome || "Contagem";
  renderMinimoBanner("contagem-alerta-minimo", lojaId);

  const sel = document.getElementById("filter-contagem-loja");
  if (sel) {
    const lojas = getLojas();
    const prev = sel.value || lojaId;
    sel.innerHTML = lojas.map((l) => `<option value="${l.id}">${esc(l.nome)}</option>`).join("");
    if (session.role === "loja") {
      sel.value = session.lojaId;
      sel.classList.add("hidden");
    } else {
      sel.classList.remove("hidden");
      sel.value = prev && [...sel.options].some((o) => o.value === prev) ? prev : lojaId;
    }
  }

  const { feitos, total } = contagemProgresso();
  const btnCont = document.getElementById("btn-continuar-contagem");
  if (btnCont) {
    const parcial = feitos > 0 && feitos < total;
    btnCont.classList.toggle("hidden", !parcial);
    btnCont.textContent = `Continuar (${feitos}/${total})`;
  }

  if (contagemPanel === "flow") renderContagemItemAtual();
  else if (contagemPanel === "lista") renderContagemLista();
  else setContagemPanel("start");
}

function bindContagemEvents() {
  document.getElementById("btn-iniciar-contagem")?.addEventListener("click", () => {
    if (!can("contagem")) return;
    iniciarContagem({ zerar: true });
  });
  document.getElementById("btn-continuar-contagem")?.addEventListener("click", () => {
    if (!can("contagem")) return;
    iniciarContagem({ zerar: false });
  });
  document.getElementById("btn-ver-lista-contagem")?.addEventListener("click", () => {
    if (!can("contagem")) return;
    setContagemPanel("lista");
    renderContagemLista();
  });
  document.getElementById("btn-contagem-ir-lista")?.addEventListener("click", () => {
    if (!can("contagem")) return;
    setContagemPanel("lista");
    renderContagemLista();
  });
  document.getElementById("btn-contagem-voltar-fluxo")?.addEventListener("click", () => {
    if (!can("contagem")) return;
    const lojaId = contagemLojaId();
    const produtos = produtosContagemLoja();
    contagemFlowIds = produtos.map((p) => p.id);
    contagemFlowIdx = Math.max(
      0,
      contagemFlowIds.findIndex((id) => !foiContadoHoje(ensureEstoque(lojaId, id)))
    );
    if (contagemFlowIdx < 0) contagemFlowIdx = 0;
    setContagemPanel("flow");
    renderContagemItemAtual();
  });
  document.getElementById("btn-contagem-inicio")?.addEventListener("click", () => {
    if (!can("contagem")) return;
    setContagemPanel("start");
    renderContagem();
  });
  document.getElementById("btn-contagem-sair-fluxo")?.addEventListener("click", () => {
    if (!can("contagem")) return;
    setContagemPanel("start");
    renderContagem();
  });
  document.getElementById("btn-contagem-pular")?.addEventListener("click", () => {
    if (!can("contagem")) return;
    const card = document.getElementById("contagem-item-card");
    if (card?._contagemPular) card._contagemPular();
    else {
      const lojaId = contagemLojaId();
      const pid = contagemFlowIds[contagemFlowIdx];
      if (!pid) return;
      setContagemSaldo(lojaId, pid, 0, true);
      contagemFlowIdx += 1;
      renderContagemItemAtual();
    }
  });
  document.getElementById("filter-contagem-loja")?.addEventListener("change", () => {
    contagemPanel = "start";
    contagemFlowIds = [];
    contagemFlowIdx = 0;
    if (can("contagem")) renderContagem();
  });
}

function canManageProdutos() {
  return session?.role === "admin" || (session?.role === "loja" && session.lojaId === "central");
}

function uniqueProdutoId(nome) {
  let base = slugify(nome).slice(0, 48) || `produto-${Date.now().toString(36)}`;
  let pid = base;
  let n = 2;
  while (state.produtos.some((p) => p.id === pid)) {
    pid = `${base}-${n}`;
    n += 1;
  }
  return pid;
}

function ensureProdutoEverywhere(produtoId) {
  getAllLojas().forEach((l) => ensureEstoque(l.id, produtoId));
  getAllFornecedores().forEach((f) => ensureCotacao(f.id, produtoId));
  ensureProducao(produtoId);
}

function softDeleteProduto(produtoId) {
  const p = getProduto(produtoId);
  if (!p) return;
  p.ativo = false;
  scheduleSave();
}

function hardDeleteProduto(produtoId) {
  state.produtos = state.produtos.filter((p) => p.id !== produtoId);
  getAllLojas().forEach((l) => {
    if (state.estoques[l.id]) delete state.estoques[l.id][produtoId];
  });
  getAllFornecedores().forEach((f) => {
    if (state.cotacoes[f.id]) delete state.cotacoes[f.id][produtoId];
  });
  if (state.producao) delete state.producao[produtoId];
  if (state.receitasMinimoFabrica) delete state.receitasMinimoFabrica[produtoId];
  if (state.producaoAuto) delete state.producaoAuto[produtoId];
  if (state.baldesPor) delete state.baldesPor[produtoId];
  if (state.producoesAplicadas) {
    Object.keys(state.producoesAplicadas).forEach((k) => {
      if (k.startsWith(`${produtoId}|`)) delete state.producoesAplicadas[k];
    });
  }
  scheduleSave();
}

/* ── Estoque ── */
function renderEstoque() {
  if (lojaScope() === "fabrica" || session.role === "admin") syncProducaoEMinimosFabrica();
  const lojaId = lojaScope();
  renderMinimoBanner("estoque-alerta-minimo", lojaId);

  const mismatches = listLotesMismatch(lojaId);
  const mismEl = document.getElementById("estoque-lotes-mismatch");
  if (mismEl) {
    if (mismatches.length) {
      mismEl.classList.remove("hidden");
      mismEl.innerHTML = `<div class="alert-banner alert-warn" role="status">
        <strong>Lotes ≠ saldo</strong>
        <span>${mismatches.length} produto(s) com soma dos lotes diferente do saldo.</span>
        ${
          session.role === "admin" || (session.role === "loja" && session.lojaId === lojaId)
            ? `<button class="btn btn-sm" type="button" id="btn-igualar-saldos-lotes">Igualar saldo à soma dos lotes</button>`
            : ""
        }
      </div>`;
      document.getElementById("btn-igualar-saldos-lotes")?.addEventListener("click", () => igualarSaldosMismatch(lojaId));
    } else {
      mismEl.innerHTML = "";
      mismEl.classList.add("hidden");
    }
  }

  const cat = document.getElementById("filter-categoria").value;
  const busca = document.getElementById("filter-estoque-busca").value.toLowerCase();
  const soBaixo = document.getElementById("filter-so-baixo").checked;
  const incluirInativos = document.getElementById("filter-estoque-inativos")?.checked;
  const incluirOcultos = document.getElementById("filter-estoque-ocultos")?.checked === true;
  const tbody = document.querySelector("#table-estoque tbody");
  const cardsEl = document.getElementById("estoque-cards");
  const tableWrap = document.querySelector("#view-estoque .table-wrap");
  const canEdit = session.role === "admin" || (session.role === "loja" && session.lojaId === lojaId);
  const canMinimoFab = lojaId === "fabrica" && canEditMinimoFabrica();
  const crudCentral = canManageProdutos() && lojaId === "central";
  const useCards =
    session.role === "loja" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches;

  const btnAdd = document.getElementById("btn-estoque-add-produto");
  const wrapInativos = document.getElementById("wrap-estoque-inativos");
  const colAcoes = document.querySelector("#table-estoque .col-prod-acoes");
  const hintFab = document.getElementById("estoque-minimo-hint");
  if (btnAdd) btnAdd.classList.toggle("hidden", !crudCentral);
  if (wrapInativos) wrapInativos.classList.toggle("hidden", !crudCentral);
  if (colAcoes) colAcoes.classList.toggle("hidden", !crudCentral && !(canEdit && incluirOcultos));
  if (hintFab) hintFab.classList.toggle("hidden", !(lojaId === "fabrica" && canMinimoFab));

  const lista =
    crudCentral && incluirInativos
      ? state.produtos
      : produtosDaLoja(lojaId, { incluirOcultos });

  const rows = lista
    .filter((p) => incluirInativos || p.ativo !== false)
    .filter((p) => !cat || p.categoria === cat)
    .filter((p) => {
      if (!busca) return true;
      const sku = String(p.sku || "").toLowerCase();
      return (
        p.nome.toLowerCase().includes(busca) ||
        p.categoria.toLowerCase().includes(busca) ||
        sku.includes(busca)
      );
    })
    .map((p) => {
      const e = ensureEstoque(lojaId, p.id);
      const st = estoqueStatus(e);
      const oculto = !produtoVisivelNaLoja(p.id, lojaId);
      return { p, e, st, oculto };
    })
    .filter((x) => !soBaixo || x.st === "baixo");

  const showFabMin = lojaId === "fabrica";
  const showAcoesVis = canEdit && (crudCentral || incluirOcultos);
  if (colAcoes) colAcoes.classList.toggle("hidden", !showAcoesVis);
  const colSpan = (showAcoesVis ? 9 : 8) + (showFabMin ? 1 : 0);

  if (tableWrap) tableWrap.classList.toggle("hidden", useCards);
  if (cardsEl) {
    cardsEl.classList.toggle("hidden", !useCards);
    if (useCards) {
      cardsEl.innerHTML = rows.length
        ? rows
            .map(({ p, e, st }) => {
              const statusLabel = st === "baixo" ? "Abaixo" : st === "atencao" ? "Atenção" : "OK";
              return `<button type="button" class="estoque-card row-${st}" data-pid="${p.id}">
                <div class="estoque-card-top">
                  <strong>${esc(p.nome)}</strong>
                  <span class="badge badge-${st === "baixo" ? "baixo" : "ok"}">${statusLabel}</span>
                </div>
                <div class="estoque-card-meta">
                  <span>Saldo <strong>${formatNum(e.saldo)}</strong> ${esc(p.unidade || "")}</span>
                  <span>Mín ${formatNum(e.minimo)}</span>
                </div>
              </button>`;
            })
            .join("")
        : '<p class="empty-state">Nenhum produto encontrado</p>';
      cardsEl.querySelectorAll(".estoque-card[data-pid]").forEach((card) => {
        card.addEventListener("click", () => openEstoqueCardEditor(lojaId, card.dataset.pid));
      });
    }
  }

  // Adjust header for fábrica modo column
  const thMin = [...document.querySelectorAll("#table-estoque thead th")].find((th) => th.textContent.trim() === "Mínimo");
  let thModo = document.querySelector("#table-estoque thead .col-min-modo");
  if (showFabMin) {
    if (!thModo && thMin) {
      thModo = document.createElement("th");
      thModo.className = "col-min-modo";
      thModo.textContent = "Modo mín.";
      thMin.after(thModo);
    }
  } else if (thModo) {
    thModo.remove();
  }

  if (!tbody) return;
  if (useCards) {
    tbody.innerHTML = "";
    return;
  }

  tbody.innerHTML = rows.length
    ? rows
        .map(({ p, e, st, oculto }) => {
          const dis = canEdit ? "" : "disabled";
          const temReceita = showFabMin && hasReceitaFabrica(p.id);
          const modo = temReceita ? minimoModoFabrica(e, p.id) : showFabMin ? "fixo" : null;
          const isManual = temReceita && modo === "fixo";
          const isAuto = temReceita && modo === "formula";
          const disMin = !canEdit || isAuto ? "disabled" : "";
          const disModo = canMinimoFab ? "" : "disabled";
          const nLotes = (e.lotes || []).length;
          const somaLotes = somaQtdeLotes(e);
          const saldoNum = Number(e.saldo) || 0;
          const lotesMismatch = nLotes > 0 && Math.abs(somaLotes - saldoNum) > 1e-6;
          const lotesLabel = nLotes ? `${nLotes} lote${nLotes > 1 ? "s" : ""}` : "Gerenciar";
          const skuBit = p.sku ? `<span class="muted-sm"> · ${esc(p.sku)}</span>` : "";
          const modoCell = showFabMin
            ? `<td class="td-min-modo">
                <div class="min-modo-controls">
                  ${badgeMinimoModoHtml(modo || "fixo")}
                  ${
                    temReceita
                      ? `<select class="min-modo-select" data-min-modo="${p.id}" ${disModo} title="Modo do estoque mínimo">
                           <option value="formula" ${isAuto ? "selected" : ""}>Fórmula</option>
                           <option value="fixo" ${isManual ? "selected" : ""}>Fixo</option>
                         </select>
                         <button class="btn btn-ghost btn-sm" data-min-formula="${p.id}" type="button" ${disModo} title="${escAttr(descricaoReceitaFabrica(p.id))}">Editar…</button>`
                      : ""
                  }
                </div>
              </td>`
            : "";
          const acoesVis = showAcoesVis
            ? `<td class="td-acoes">
                ${
                  crudCentral
                    ? `<button class="btn btn-ghost btn-sm" data-edit-prod="${p.id}" type="button">Editar</button>
                ${
                  p.ativo
                    ? `<button class="btn-danger btn-sm" data-del-prod="${p.id}" type="button">Excluir</button>`
                    : `<button class="btn btn-sm" data-react-prod="${p.id}" type="button">Reativar</button>`
                }`
                    : ""
                }
                ${
                  incluirOcultos
                    ? `<button class="btn btn-ghost btn-sm" data-toggle-vis="${p.id}" data-incluir="${oculto ? "1" : "0"}" type="button">${oculto ? "Usar nesta loja" : "Ocultar na loja"}</button>`
                    : ""
                }
              </td>`
            : "";
          return `<tr class="row-${st}${p.ativo === false ? " row-inativo" : ""}${oculto ? " row-oculto" : ""}" data-pid="${p.id}">
          <td class="col-sticky-produto"><strong>${esc(p.nome)}</strong>${skuBit}${p.ativo === false ? ' <span class="badge badge-inativo">Inativo</span>' : ""}${oculto ? ' <span class="badge badge-inativo">oculto</span>' : ""}</td>
          <td>${esc(p.categoria)}</td>
          <td>${esc(p.unidade)}</td>
          <td><input class="cell-input" data-field="saldo" ${dis} step="any" type="number" value="${e.saldo}" /></td>
          <td>
            <input class="cell-input cell-minimo ${isAuto ? "cell-lilas" : ""}" data-field="minimo" ${disMin} step="any" type="number" value="${e.minimo}" title="${isAuto ? "Calculado pela fórmula — mude o modo para Fixo para editar" : "Estoque mínimo"}" />
          </td>
          ${modoCell}
          <td><input class="cell-input" data-field="envio" ${dis} step="any" type="number" value="${e.envio}" /></td>
          <td class="td-lotes">
            <button class="btn btn-ghost btn-sm" data-lotes="${p.id}" type="button">${esc(lotesLabel)}</button>
            ${lotesMismatch ? `<span class="lotes-mismatch" title="Soma dos lotes difere do saldo">Σ ${formatNum(somaLotes)}</span>` : ""}
          </td>
          <td><span class="badge badge-${st === "baixo" ? "baixo" : "ok"}">${st === "baixo" ? "Baixo" : st === "atencao" ? "Atenção" : "OK"}</span></td>
          ${acoesVis}
        </tr>`;
        })
        .join("")
    : `<tr><td colspan="${colSpan}" class="empty-state">Nenhum produto encontrado</td></tr>`;

  tbody.querySelectorAll("tr[data-pid]").forEach((tr) => {
    const pid = tr.dataset.pid;
    tr.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("change", () => {
        const entry = ensureEstoque(lojaId, pid);
        const field = input.dataset.field;
        if (input.type === "checkbox") {
          entry[field] = input.checked;
          scheduleSave();
          return;
        }
        if (field === "minimo") {
          const emFormula =
            lojaId === "fabrica" && hasReceitaFabrica(pid) && minimoModoFabrica(entry, pid) === "formula";
          if (emFormula) {
            input.value = entry.minimo ?? 0;
            return;
          }
          setMinimoEstoque(lojaId, pid, input.value, {
            manualOverride: lojaId === "fabrica" && hasReceitaFabrica(pid),
          });
          if (lojaId === "fabrica" && hasReceitaFabrica(pid)) {
            renderEstoque();
            return;
          }
          scheduleSave();
          return;
        }
        if (field === "saldo") {
          const de = Number(entry.saldo) || 0;
          const para = Math.max(0, Number(input.value) || 0);
          if (de === para) return;
          input.value = de;
          openSaldoMotivoModal({ lojaId, produtoId: pid, de, para }, ({ motivo, nota }) => {
            setSaldoComMotivo(lojaId, pid, para, { motivo, nota, tipo: "ajuste" });
            scheduleSave();
            renderEstoque();
          });
          return;
        }
        if (input.type === "number") entry[field] = Number(input.value) || 0;
        else entry[field] = input.value;
        scheduleSave();
        const st = estoqueStatus(entry);
        tr.className = `row-${st}${getProduto(pid)?.ativo === false ? " row-inativo" : ""}`;
        const badge = tr.querySelector(".badge:not(.badge-inativo):not(.badge-modo-fixo):not(.badge-modo-formula)");
        if (badge) {
          badge.className = `badge badge-${st === "baixo" ? "baixo" : "ok"}`;
          badge.textContent = st === "baixo" ? "Baixo" : st === "atencao" ? "Atenção" : "OK";
        }
      });
    });
  });

  tbody.querySelectorAll("[data-lotes]").forEach((btn) => {
    btn.addEventListener("click", () => openLotesModal(lojaId, btn.dataset.lotes));
  });

  tbody.querySelectorAll("[data-min-modo]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const pid = sel.dataset.minModo;
      const done = setMinimoModoFabrica(pid, sel.value);
      if (!done) {
        const e = ensureEstoque(lojaId, pid);
        sel.value = minimoModoFabrica(e, pid);
        return;
      }
      renderEstoque();
    });
  });
  tbody.querySelectorAll("[data-min-formula]").forEach((btn) => {
    btn.addEventListener("click", () => openMinimoFabricaModal(btn.dataset.minFormula));
  });

  tbody.querySelectorAll("[data-edit-prod]").forEach((btn) => {
    btn.addEventListener("click", () => openProdutoModal(btn.dataset.editProd));
  });
  tbody.querySelectorAll("[data-del-prod]").forEach((btn) => {
    btn.addEventListener("click", () => confirmDeleteProduto(btn.dataset.delProd));
  });
  tbody.querySelectorAll("[data-react-prod]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = getProduto(btn.dataset.reactProd);
      if (!p) return;
      p.ativo = true;
      scheduleSave();
      setupRoleFilters();
      renderEstoque();
    });
  });
  tbody.querySelectorAll("[data-toggle-vis]").forEach((btn) => {
    btn.addEventListener("click", () => {
      toggleProdutoNaLoja(lojaId, btn.dataset.toggleVis, btn.dataset.incluir === "1");
      renderEstoque();
    });
  });
}

function openEstoqueCardEditor(lojaId, produtoId) {
  const p = getProduto(produtoId);
  const entry = ensureEstoque(lojaId, produtoId);
  if (!p) return;
  const canEdit = session.role === "admin" || (session.role === "loja" && session.lojaId === lojaId);
  const modal = document.getElementById("modal");
  const saveBtn = document.getElementById("modal-save");
  const cancelBtn = document.getElementById("modal-cancel");
  const st = estoqueStatus(entry);
  document.getElementById("modal-title").textContent = p.nome;
  document.getElementById("modal-body").innerHTML = `
    <p class="toolbar-hint">${esc(p.categoria)} · ${esc(p.unidade)} ·
      <span class="badge badge-${st === "baixo" ? "baixo" : "ok"}">${st === "baixo" ? "Abaixo" : st === "atencao" ? "Atenção" : "OK"}</span>
    </p>
    <label class="field"><span>Saldo</span>
      <input id="card-saldo" ${canEdit ? "" : "disabled"} step="any" type="number" value="${entry.saldo}" /></label>
    <label class="field"><span>Mínimo</span>
      <input id="card-minimo" ${canEdit ? "" : "disabled"} step="any" type="number" value="${entry.minimo}" /></label>
    <button class="btn btn-ghost btn-block" id="card-lotes" type="button">Gerenciar lotes</button>`;
  if (saveBtn) {
    saveBtn.classList.toggle("hidden", !canEdit);
    saveBtn.textContent = "Salvar";
  }
  if (cancelBtn) cancelBtn.textContent = canEdit ? "Cancelar" : "Fechar";
  modal.showModal();
  document.getElementById("card-lotes")?.addEventListener("click", () => {
    modal.close();
    openLotesModal(lojaId, produtoId);
  });
  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    if (!canEdit) {
      modal.close();
      return;
    }
    const novoSaldo = Math.max(0, Number(document.getElementById("card-saldo")?.value) || 0);
    const novoMin = Math.max(0, Number(document.getElementById("card-minimo")?.value) || 0);
    const de = Number(entry.saldo) || 0;
    entry.minimo = novoMin;
    if (de !== novoSaldo) {
      modal.close();
      openSaldoMotivoModal({ lojaId, produtoId, de, para: novoSaldo }, ({ motivo, nota }) => {
        setSaldoComMotivo(lojaId, produtoId, novoSaldo, { motivo, nota, tipo: "ajuste" });
        scheduleSave();
        renderEstoque();
      });
      return;
    }
    scheduleSave();
    modal.close();
    renderEstoque();
  };
}

function confirmDeleteProduto(produtoId) {
  const p = getProduto(produtoId);
  if (!p) return;
  const msg =
    `Excluir o produto "${p.nome}"?\n\n` +
    `OK = desativar (some das contagens, pode reativar)\n` +
    `Cancelar = não excluir\n\n` +
    `Para apagar de vez (todas as lojas), confirme de novo depois.`;
  if (!confirm(msg)) return;
  softDeleteProduto(produtoId);
  if (
    confirm(
      `Produto desativado.\n\nDeseja APAGAR DEFINITIVAMENTE "${p.nome}" (saldo/cotação/produção)?\nIsso não tem volta.`
    )
  ) {
    hardDeleteProduto(produtoId);
  }
  setupRoleFilters();
  render();
}

/* ── Produção ── */
function inicioSemanaISO(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return toISODate(d);
}

function cicloProducaoAtual() {
  return inicioSemanaISO();
}

function getProducaoAplicadaKey(produtoId, ciclo) {
  return `${produtoId}|${ciclo || cicloProducaoAtual()}`;
}

function isProducaoConcluidaCiclo(pr, ciclo = cicloProducaoAtual()) {
  return !!(pr?.producaoAplicadaEm && pr.producaoAplicadaEm === ciclo);
}

function canEditProducaoFabrica() {
  return session?.role === "admin" || (session?.role === "loja" && session.lojaId === "fabrica");
}

/** Semana nova após conclusão: zera “já produzido” (histórico fica em producoesAplicadas). */
function refreshProducaoCicloEntry(pr) {
  const ciclo = cicloProducaoAtual();
  if (pr.producaoAplicadaEm && pr.producaoAplicadaEm !== ciclo) {
    pr.totalProduzido = 0;
    pr.producaoAplicadaEm = "";
    pr.concluidoAt = "";
    pr.concluidoQtde = 0;
    return true;
  }
  return false;
}

function concluirProducaoItens(produtoIds) {
  if (!canEditProducaoFabrica()) {
    alert("Somente Fábrica ou Admin podem concluir produção.");
    return;
  }
  const ciclo = cicloProducaoAtual();
  const elegiveis = [];
  (produtoIds || []).forEach((pid) => {
    if (!pid) return;
    const pr = ensureProducao(pid);
    refreshProducaoCicloEntry(pr);
    if (isProducaoConcluidaCiclo(pr, ciclo)) return;
    const q = Math.max(0, Number(pr.totalProduzido) || 0);
    if (q <= 0) return;
    elegiveis.push({ pid, pr, q, nome: getProduto(pid)?.nome || pid });
  });

  if (!elegiveis.length) {
    alert(
      'Nenhum item elegível: informe "Já produzido" > 0 e que ainda não esteja concluído nesta semana.'
    );
    return;
  }

  const resumo = elegiveis.map((x) => `• ${x.nome}: ${formatNum(x.q)}`).join("\n");
  if (
    !confirm(
      `Concluir produção e creditar no Estoque Central?\n` +
        `Ciclo (semana a partir de ${formatDateBR(ciclo)})\n\n` +
        `${resumo}`
    )
  ) {
    return;
  }

  if (!state.producoesAplicadas) state.producoesAplicadas = {};
  const aplicadoAt = new Date().toISOString();
  elegiveis.forEach(({ pid, pr, q }) => {
    const centralEst = ensureEstoque("central", pid);
    const de = Number(centralEst.saldo || 0);
    centralEst.saldo = Math.round((de + q) * 1000) / 1000;
    pushMovimento({
      lojaId: "central",
      produtoId: pid,
      de,
      para: centralEst.saldo,
      motivo: "producao",
      nota: `Conclusão produção ciclo ${ciclo}`,
      tipo: "producao",
    });
    pr.producaoAplicadaEm = ciclo;
    pr.concluidoAt = aplicadoAt;
    pr.concluidoQtde = q;
    state.producoesAplicadas[getProducaoAplicadaKey(pid, ciclo)] = {
      aplicado: true,
      produtoId: pid,
      ciclo,
      qtde: q,
      aplicadoAt,
      aplicadoPor: session?.userId || "",
    };
  });

  scheduleSave();
  syncProducaoEMinimosFabrica();
  renderProducao();
  alert(`Produção concluída: ${elegiveis.length} item(ns) creditados no Central.`);
}

function desfazerConclusaoProducao(produtoId) {
  if (session?.role !== "admin") {
    alert("Somente Admin pode desfazer a conclusão.");
    return;
  }
  const ciclo = cicloProducaoAtual();
  const pr = ensureProducao(produtoId);
  if (!isProducaoConcluidaCiclo(pr, ciclo)) {
    alert("Este item não está concluído no ciclo atual.");
    return;
  }
  const q = Number(pr.concluidoQtde || pr.totalProduzido) || 0;
  const nome = getProduto(produtoId)?.nome || produtoId;
  if (
    !confirm(
      `Desfazer conclusão de "${nome}"?\nRemove ${formatNum(q)} do Estoque Central (saldo pode ficar negativo).`
    )
  ) {
    return;
  }
  const centralEst = ensureEstoque("central", produtoId);
  const de = Number(centralEst.saldo || 0);
  centralEst.saldo = Math.round((de - q) * 1000) / 1000;
  pushMovimento({
    lojaId: "central",
    produtoId,
    de,
    para: centralEst.saldo,
    motivo: "producao",
    nota: `Desfazer conclusão produção ciclo ${ciclo}`,
    tipo: "producao",
  });
  pr.producaoAplicadaEm = "";
  pr.concluidoAt = "";
  pr.concluidoQtde = 0;
  if (state.producoesAplicadas) delete state.producoesAplicadas[getProducaoAplicadaKey(produtoId, ciclo)];
  scheduleSave();
  syncProducaoEMinimosFabrica();
  renderProducao();
}

function listItensProducaoParaConcluirLote() {
  const ciclo = cicloProducaoAtual();
  return produtosAtivos()
    .map((p) => ({ p, pr: ensureProducao(p.id) }))
    .filter(({ pr }) => {
      refreshProducaoCicloEntry(pr);
      return (
        pr.lista === "PRODUZIR" &&
        !isProducaoConcluidaCiclo(pr, ciclo) &&
        Number(pr.totalProduzido) > 0
      );
    })
    .map(({ p }) => p.id);
}

function renderProducao() {
  syncProducaoEMinimosFabrica();
  const so = document.getElementById("filter-so-produzir").checked;
  const tbody = document.querySelector("#table-producao tbody");
  const isFab = session.role === "loja" && session.lojaId === "fabrica";
  const canEditMeta = session.role === "admin";
  const canEditProduzidoBase = canEditProducaoFabrica();
  const ciclo = cicloProducaoAtual();
  let cicloDirty = false;

  const rows = produtosAtivos()
    .map((p) => {
      const pr = ensureProducao(p.id);
      if (refreshProducaoCicloEntry(pr)) cicloDirty = true;
      return { p, pr };
    })
    .filter((x) => !so || x.pr.lista === "PRODUZIR");

  if (cicloDirty) scheduleSave();

  const produzirRows = rows.filter((x) => x.pr.lista === "PRODUZIR");
  let feitos = 0;
  let somaPct = 0;
  produzirRows.forEach(({ pr }) => {
    const total = Math.max(0, Number(pr.totalProduzir) || 0);
    const prod = Math.max(0, Number(pr.totalProduzido) || 0);
    if (isProducaoConcluidaCiclo(pr, ciclo) || (total > 0 && prod >= total) || (total === 0 && prod > 0)) {
      feitos++;
    }
    const pct = total > 0 ? Math.min(100, (prod / total) * 100) : prod > 0 ? 100 : 0;
    somaPct += pct;
  });
  const nProd = produzirRows.length;
  const pctGeral = nProd ? Math.round(somaPct / nProd) : 0;

  const progressEl = document.getElementById("producao-progress");
  const progressBar = document.getElementById("producao-progress-bar");
  const metaCiclo = document.getElementById("producao-ciclo-meta");
  if (progressEl) {
    progressEl.textContent = nProd
      ? `${feitos} de ${nProd} na lista · média ${pctGeral}% produzido`
      : "Nenhum item PRODUZIR nesta semana";
  }
  if (progressBar) progressBar.style.width = `${pctGeral}%`;
  if (metaCiclo) {
    metaCiclo.textContent = `Ciclo: semana de ${formatDateBR(ciclo)}`;
  }

  const btnLote = document.getElementById("btn-producao-concluir-lote");
  if (btnLote) {
    btnLote.classList.toggle("hidden", !canEditProduzidoBase);
    const nLote = listItensProducaoParaConcluirLote().length;
    btnLote.disabled = nLote === 0;
    btnLote.textContent =
      nLote > 0 ? `Concluir produção (${nLote})` : "Concluir produção";
  }

  tbody.innerHTML = rows.length
    ? rows
        .map(({ p, pr }) => {
          const total = Number(pr.totalProduzir) || 0;
          const prod = Number(pr.totalProduzido) || 0;
          const falta = Math.max(0, total - prod);
          const concluido = isProducaoConcluidaCiclo(pr, ciclo);
          const auto = !!(state.producaoAuto || {})[p.id];
          const disMeta = canEditMeta && !auto && !concluido ? "" : "disabled";
          const disProd = canEditProduzidoBase && !concluido ? "" : "disabled";
          const pct = total > 0 ? Math.min(100, Math.round((prod / total) * 100)) : prod > 0 ? 100 : 0;
          let rowClass = "";
          if (concluido) rowClass = "row-concluido";
          else if (pr.lista === "PRODUZIR") rowClass = falta > 0 ? "row-atencao" : "row-ok";

          let statusHtml = '<span class="badge badge-falta">Pendente</span>';
          if (concluido) {
            statusHtml = `<span class="badge badge-ok" title="Creditado em ${esc(
              formatDateTimeBR(pr.concluidoAt)
            )}">Concluído</span>`;
          } else if (prod > 0) {
            statusHtml = `<span class="badge badge-baixo">Em andamento</span>`;
          }

          let acaoHtml = "—";
          if (concluido && session.role === "admin") {
            acaoHtml = `<button type="button" class="btn btn-ghost btn-sm" data-acao="desfazer">Desfazer</button>`;
          } else if (!concluido && canEditProduzidoBase) {
            acaoHtml = `<button type="button" class="btn btn-sm" data-acao="concluir" ${
              prod > 0 ? "" : "disabled"
            }>Concluir</button>`;
          } else if (concluido) {
            acaoHtml = `<span class="muted-sm">Central +${formatNum(pr.concluidoQtde || prod)}</span>`;
          }

          return `<tr class="${rowClass}" data-pid="${p.id}">
            <td class="col-sticky-produto"><strong>${esc(p.nome)}</strong>${auto ? ' <span class="pill-lilas" title="Gerado pela necessidade (mín − atual)">auto</span>' : ""}</td>
            <td>${esc(p.unidade)}</td>
            <td>
              <select class="cell-input wide" data-field="lista" ${disMeta}>
                <option value="" ${pr.lista !== "PRODUZIR" ? "selected" : ""}>—</option>
                <option value="PRODUZIR" ${pr.lista === "PRODUZIR" ? "selected" : ""}>PRODUZIR</option>
              </select>
            </td>
            <td><input class="cell-input" data-field="totalProduzir" ${disMeta} step="any" type="number" value="${pr.totalProduzir}" /></td>
            <td><input class="cell-input" data-field="qtdeBaldes" ${disMeta} step="any" type="number" value="${pr.qtdeBaldes}" /></td>
            <td><input class="cell-input" data-field="totalProduzido" ${disProd} step="any" type="number" min="0" value="${pr.totalProduzido}" /></td>
            <td>
              <strong data-falta>${formatNum(falta)}</strong>
              <div class="producao-row-progress" title="${pct}%"><div style="width:${pct}%"></div></div>
            </td>
            <td>${statusHtml}</td>
            <td class="td-acoes">${acaoHtml}</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="9" class="empty-state">Nada a produzir — estoque das lojas está acima do mínimo</td></tr>';

  tbody.querySelectorAll("tr[data-pid]").forEach((tr) => {
    const pid = tr.dataset.pid;
    tr.querySelectorAll("[data-field]").forEach((input) => {
      const field = input.dataset.field;
      if (field === "totalProduzido") {
        input.addEventListener("input", () => {
          const pr = ensureProducao(pid);
          const total = Number(pr.totalProduzir) || 0;
          const prod = Number(input.value) || 0;
          const faltaEl = tr.querySelector("[data-falta]");
          if (faltaEl) faltaEl.textContent = formatNum(Math.max(0, total - prod));
          const bar = tr.querySelector(".producao-row-progress > div");
          if (bar) {
            const pct = total > 0 ? Math.min(100, Math.round((prod / total) * 100)) : prod > 0 ? 100 : 0;
            bar.style.width = `${pct}%`;
          }
          const btn = tr.querySelector('[data-acao="concluir"]');
          if (btn) btn.disabled = !(prod > 0);
        });
      }
      input.addEventListener("change", () => {
        const pr = ensureProducao(pid);
        if (isProducaoConcluidaCiclo(pr, ciclo) && field === "totalProduzido" && session.role !== "admin") {
          renderProducao();
          return;
        }
        pr[field] = input.type === "number" ? Number(input.value) || 0 : input.value;
        if (field === "totalProduzido") pr.totalProduzido = Math.max(0, Number(pr.totalProduzido) || 0);
        scheduleSave();
        renderProducao();
      });
    });
    tr.querySelector('[data-acao="concluir"]')?.addEventListener("click", () => {
      concluirProducaoItens([pid]);
    });
    tr.querySelector('[data-acao="desfazer"]')?.addEventListener("click", () => {
      desfazerConclusaoProducao(pid);
    });
  });
}

function montarProducaoPrintSheet() {
  syncProducaoEMinimosFabrica();
  const so = document.getElementById("filter-so-produzir")?.checked !== false;
  const rows = produtosAtivos()
    .map((p) => ({ p, pr: ensureProducao(p.id) }))
    .filter((x) => !so || x.pr.lista === "PRODUZIR");

  if (!rows.length) {
    alert("Nenhum item de produção para exportar.");
    return null;
  }

  const sheet = document.getElementById("producao-print-sheet");
  const body = document.getElementById("producao-print-body");
  const meta = document.getElementById("producao-print-meta");

  let totalProduzir = 0;
  let totalFalta = 0;
  const ciclo = cicloProducaoAtual();
  body.innerHTML = `<table class="data-table">
    <thead>
      <tr>
        <th>Produto</th>
        <th>UN</th>
        <th>A produzir</th>
        <th>Baldes</th>
        <th>Produzido</th>
        <th>Falta</th>
        <th>Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows
        .map(({ p, pr }) => {
          refreshProducaoCicloEntry(pr);
          const falta = Math.max(0, Number(pr.totalProduzir) - Number(pr.totalProduzido));
          totalProduzir += Number(pr.totalProduzir) || 0;
          totalFalta += falta;
          const st = isProducaoConcluidaCiclo(pr, ciclo)
            ? "Concluído"
            : Number(pr.totalProduzido) > 0
              ? "Em andamento"
              : "Pendente";
          return `<tr>
            <td>${esc(p.nome)}</td>
            <td>${esc(p.unidade)}</td>
            <td>${formatNum(pr.totalProduzir)}</td>
            <td>${formatNum(pr.qtdeBaldes)}</td>
            <td>${formatNum(pr.totalProduzido)}</td>
            <td><strong>${formatNum(falta)}</strong></td>
            <td>${st}</td>
          </tr>`;
        })
        .join("")}
    </tbody>
    <tfoot>
      <tr class="totals-row">
        <td colspan="2"><strong>Totais</strong></td>
        <td><strong>${formatNum(totalProduzir)}</strong></td>
        <td></td>
        <td></td>
        <td><strong>${formatNum(totalFalta)}</strong></td>
        <td></td>
      </tr>
    </tfoot>
  </table>`;

  if (meta) {
    meta.textContent = `Emitido em ${formatDateBR(hojeISO())} · ciclo ${formatDateBR(ciclo)} · ${rows.length} item(ns)${so ? " · só PRODUZIR" : ""}`;
  }

  return { sheet, filename: `producao-fabrica-${hojeISO()}` };
}

function exportarProducao(modo = "pdf") {
  const built = montarProducaoPrintSheet();
  if (!built) return;
  const { sheet, filename } = built;
  if (modo === "print") {
    sheet.classList.remove("hidden");
    document.body.classList.add("printing-producao");
    window.print();
    window.addEventListener(
      "afterprint",
      () => {
        document.body.classList.remove("printing-producao");
        sheet.classList.add("hidden");
      },
      { once: true }
    );
    return;
  }
  exportElementToPdf(sheet, filename, "printing-producao");
}

/* ── Cotação ── */
function renderCotacao() {
  syncProducaoEMinimosFabrica();
  const fid = fornScope();
  const cat = document.getElementById("filter-cot-categoria").value;
  const busca = document.getElementById("filter-cot-busca").value.toLowerCase();
  const host = document.getElementById("cotacao-acordeoes");
  if (!host) return;
  const agenda = labelStatusCotacaoAgenda();
  const fornecedorBloqueado = session.role === "fornecedor" && !agenda.liberada;
  const canEdit =
    session.role === "admin" ||
    (session.role === "fornecedor" && session.fornecedorId === fid && !fornecedorBloqueado);
  // Só na visão do próprio fornecedor: itens que ele ocultou não entram na tabela
  const ocultos =
    session.role === "fornecedor" ? new Set(getItensOcultosFornecedor(session.fornecedorId)) : null;

  const banner = document.getElementById("cotacao-agenda-banner");
  const badge = document.getElementById("cotacao-agenda-badge");
  if (banner) {
    if (fornecedorBloqueado && agenda.banner) {
      banner.classList.remove("hidden");
      banner.innerHTML = `<strong>${esc(agenda.banner)}</strong><span>Edição de preços e quantidades está bloqueada neste horário.</span>`;
    } else if (session.role === "admin" && !agenda.liberada) {
      banner.classList.remove("hidden");
      banner.innerHTML = `<strong>${esc(agenda.banner || "Cotação travada para fornecedores")}</strong><span>Você (admin) ainda pode editar.</span>`;
    } else {
      banner.classList.add("hidden");
      banner.innerHTML = "";
    }
  }
  if (badge) {
    if (session.role === "fornecedor" && agenda.liberada && agenda.badge && ensureCotacaoAgenda().modo === "auto") {
      badge.classList.remove("hidden");
      badge.textContent = agenda.badge;
    } else if (session.role === "admin" && agenda.badge) {
      badge.classList.remove("hidden");
      badge.textContent = agenda.badge;
    } else {
      badge.classList.add("hidden");
      badge.textContent = "";
    }
  }
  const hint = document.getElementById("cotacao-hint");
  if (hint && session.role === "fornecedor") {
    hint.textContent = fornecedorBloqueado
      ? agenda.banner || "Cotação travada — edição desabilitada."
      : `Você está cotando como ${session.nome}. Só esta cotação é editável.`;
  }

  // sync open state before rebuild
  host.querySelectorAll(".cotacao-acc").forEach((el) => {
    const key = el.dataset.cat;
    if (!key) return;
    if (el.open) cotacaoAccOpen.add(key);
    else cotacaoAccOpen.delete(key);
  });

  // sync qtde from necessidade (mín − atual) for admin convenience
  let totalOk = 0;
  const rows = produtosAtivos()
    .filter((p) => !ocultos || !ocultos.has(p.id))
    .filter((p) => !cat || p.categoria === cat)
    .filter((p) => !busca || p.nome.toLowerCase().includes(busca))
    .map((p) => {
      const c = ensureCotacao(fid, p.id);
      // if qtde empty and buy need > 0, show buy need as default qtde for display/edit
      if (session.role === "admin" && !c.qtde) {
        const need = qtdeComprarProduto(p.id).comprar;
        if (need > 0) c.qtde = need;
      }
      return { p, c };
    });

  // for fornecedor: show mainly items with qtde > 0, or all if none
  const filtered =
    session.role === "fornecedor" && rows.some((r) => Number(r.c.qtde) > 0)
      ? rows.filter((r) => Number(r.c.qtde) > 0)
      : rows;

  const byCat = new Map();
  filtered.forEach((row) => {
    const key = row.p.categoria || "Sem categoria";
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(row);
  });
  const catOrder = categorias();
  const sortedCats = [...byCat.keys()].sort((a, b) => {
    const ia = catOrder.indexOf(a);
    const ib = catOrder.indexOf(b);
    const sa = ia === -1 ? 9999 : ia;
    const sb = ib === -1 ? 9999 : ib;
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b, "pt-BR");
  });

  const rowHtml = ({ p, c }) => {
    if (String(c.status).toUpperCase() === "OK") totalOk += Number(c.qtde) * Number(c.preco);
    const dis = canEdit ? "" : "disabled";
    return `<tr data-pid="${p.id}">
      <td><strong>${esc(p.nome)}</strong></td>
      <td>${esc(p.unidade)}</td>
      <td><input class="cell-input" data-field="qtde" ${dis} step="any" type="number" value="${c.qtde}" /></td>
      <td><input class="cell-input" data-field="preco" ${dis} step="any" type="number" value="${c.preco}" /></td>
      <td><input class="cell-input wide" data-field="observacoes" ${dis} type="text" value="${escAttr(c.observacoes)}" /></td>
    </tr>`;
  };

  if (!sortedCats.length) {
    host.innerHTML = '<p class="empty-state">Nenhum item nesta cotação</p>';
  } else {
    host.innerHTML = sortedCats
      .map((catName) => {
        const items = byCat.get(catName);
        // Filtrado por uma categoria: abre; senão respeita Set (padrão fechado)
        const open = cat && cat === catName ? true : cotacaoAccOpen.has(catName);
        if (open) cotacaoAccOpen.add(catName);
        return `<details class="cotacao-acc" data-cat="${escAttr(catName)}" ${open ? "open" : ""}>
          <summary>
            <span class="cotacao-acc-chevron" aria-hidden="true">▸</span>
            <span class="cotacao-acc-title">${esc(catName)}</span>
            <span class="cotacao-acc-count">${items.length}</span>
          </summary>
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>UN</th>
                  <th>Qtde</th>
                  <th>Preço unit.</th>
                  <th>Observações</th>
                </tr>
              </thead>
              <tbody>${items.map(rowHtml).join("")}</tbody>
            </table>
          </div>
        </details>`;
      })
      .join("");
  }

  document.getElementById("cotacao-total").textContent = formatMoney(totalOk);

  host.querySelectorAll(".cotacao-acc").forEach((el) => {
    el.addEventListener("toggle", () => {
      const key = el.dataset.cat;
      if (!key) return;
      if (el.open) cotacaoAccOpen.add(key);
      else cotacaoAccOpen.delete(key);
    });
  });

  host.querySelectorAll("tr[data-pid]").forEach((tr) => {
    const pid = tr.dataset.pid;
    tr.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("change", () => {
        if (session.role === "fornecedor" && !cotacaoEstaLiberada()) return;
        const c = ensureCotacao(fid, pid);
        const field = input.dataset.field;
        if (field === "qtde" || field === "preco") c[field] = Number(input.value) || 0;
        else c[field] = input.value;
        if (field === "preco" && Number(c.preco) > 0 && c.status === "FALTA") c.status = "OK";
        scheduleSave();
        renderCotacao();
      });
    });
  });
}

/* ── Resultado ── */
function qtdeCompraProduto(produtoId) {
  const need = qtdeComprarProduto(produtoId).comprar;
  let qtde = need;
  getFornecedores().forEach((f) => {
    const c = state.cotacoes[f.id]?.[produtoId];
    if (c && Number(c.qtde) > qtde) qtde = Number(c.qtde);
  });
  return qtde;
}

function linhasResultadoCotacao() {
  return produtosAtivos().map((p) => {
    const best = melhorCotacao(p.id);
    const qtde = qtdeCompraProduto(p.id);
    const qtdePedido = best && Number(best.qtde) > 0 ? Number(best.qtde) : qtde;
    const total = best && qtdePedido > 0 ? best.preco * qtdePedido : 0;
    return { p, qtde: qtdePedido, best, total };
  });
}

function setupResultadoFornecedorFilter() {
  const sel = document.getElementById("filter-res-fornecedor");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML =
    `<option value="">Todos os fornecedores</option>` +
    getFornecedores().map((f) => `<option value="${f.id}">${esc(f.nome)}</option>`).join("");
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function renderResultado() {
  setupResultadoFornecedorFilter();
  const busca = document.getElementById("filter-res-busca")?.value.toLowerCase() || "";
  const fornId = document.getElementById("filter-res-fornecedor")?.value || "";
  const soVencedor = document.getElementById("filter-res-so-vencedor")?.checked !== false;
  const theadRow = document.querySelector("#table-resultado thead tr");
  const fornecedores = getFornecedores();

  theadRow.innerHTML = `
    <th>Produto</th>
    <th>Qtde</th>
    ${fornecedores.map((f) => `<th>${esc(f.nome)}</th>`).join("")}
    <th>Vencedor</th>
    <th>Menor R$</th>
    <th>Total compra</th>`;

  const tbody = document.querySelector("#table-resultado tbody");
  let totalGeral = 0;
  let comVencedor = 0;
  let semCotacao = 0;

  const rows = linhasResultadoCotacao()
    .filter((r) => !busca || r.p.nome.toLowerCase().includes(busca))
    .filter((r) => !fornId || (r.best && r.best.fornecedorId === fornId))
    .filter((r) => {
      if (soVencedor) return !!(r.best && r.qtde > 0);
      return r.qtde > 0 || r.best;
    });

  tbody.innerHTML = rows.length
    ? rows
        .map(({ p, qtde, best, total }) => {
          if (best && qtde > 0) {
            totalGeral += total;
            comVencedor++;
          } else if (qtde > 0 && !best) semCotacao++;
          else if (best) comVencedor++;

          const prices = fornecedores
            .map((f) => {
              const c = state.cotacoes[f.id]?.[p.id];
              if (!c || !Number(c.preco)) return "<td>—</td>";
              const isWin = best && best.fornecedorId === f.id;
              return `<td class="${isWin ? "winner-cell" : ""}">${formatMoney(c.preco)}${c.status !== "OK" ? " *" : ""}</td>`;
            })
            .join("");

          return `<tr>
            <td><strong>${esc(p.nome)}</strong></td>
            <td>${formatNum(qtde)}</td>
            ${prices}
            <td>${best ? esc(best.nome) : '<span class="badge badge-falta">FALTA</span>'}</td>
            <td>${best ? formatMoney(best.preco) : "—"}</td>
            <td>${best && qtde > 0 ? formatMoney(total) : "—"}</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="20" class="empty-state">Sem itens neste filtro</td></tr>';

  document.getElementById("resultado-total").textContent = formatMoney(totalGeral);
  document.getElementById("resultado-kpis").innerHTML = `
    <article class="kpi-card"><p class="kpi-label">Itens no filtro</p><p class="kpi-value">${rows.length}</p></article>
    <article class="kpi-card"><p class="kpi-label">Com vencedor / qtde</p><p class="kpi-value kpi-success">${comVencedor}</p></article>
    <article class="kpi-card"><p class="kpi-label">Sem cotação OK</p><p class="kpi-value kpi-danger">${semCotacao}</p></article>
    <article class="kpi-card"><p class="kpi-label">Total pedido</p><p class="kpi-value">${formatMoney(totalGeral)}</p></article>`;

  renderResultadoPedidoActions();
}

function renderResultadoPedidoActions() {
  const host = document.getElementById("resultado-pedido-actions");
  if (!host) return;
  const blocos = pedidosCompraPorFornecedor("");
  if (!blocos.length) {
    host.innerHTML =
      '<p class="toolbar-hint">Nenhum vencedor com qtde &gt; 0 para revisar pedido.</p>';
    return;
  }
  host.innerHTML = `
    <p class="toolbar-hint" style="margin:0 0 0.5rem">Revisar e emitir pedido por fornecedor vencedor:</p>
    <div class="pedido-action-chips">
      ${blocos
        .map(
          (b) => `<button class="btn btn-sm" type="button" data-revisar-pedido="${escAttr(b.fornecedorId)}">
            Revisar pedido — ${esc(b.nome)}
            <span class="pedido-chip-meta">${b.itens.length} it. · ${formatMoney(b.total)}</span>
          </button>`
        )
        .join("")}
    </div>`;
  host.querySelectorAll("[data-revisar-pedido]").forEach((btn) => {
    btn.addEventListener("click", () => abrirRevisaoPedido(btn.dataset.revisarPedido));
  });
}

function pedidosCompraPorFornecedor(fornFiltro) {
  const map = new Map();
  linhasResultadoCotacao()
    .filter((r) => r.best && r.qtde > 0)
    .filter((r) => !fornFiltro || r.best.fornecedorId === fornFiltro)
    .forEach((r) => {
      const fid = r.best.fornecedorId;
      if (!map.has(fid)) {
        map.set(fid, {
          fornecedorId: fid,
          nome: r.best.nome,
          itens: [],
          total: 0,
        });
      }
      const bloco = map.get(fid);
      bloco.itens.push(r);
      bloco.total += r.total;
    });
  return [...map.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

let pedidoDraft = null;

function getPedidosFornecedor() {
  if (!Array.isArray(state.pedidosFornecedor)) state.pedidosFornecedor = [];
  return state.pedidosFornecedor;
}

function totalItensPedido(itens) {
  return (itens || []).reduce((s, it) => s + (Number(it.total) || 0), 0);
}

function recalcularItemPedido(it) {
  const qtde = Math.max(0, Number(it.qtde) || 0);
  const preco = Math.max(0, Number(it.preco) || 0);
  it.qtde = qtde;
  it.preco = preco;
  it.total = qtde * preco;
  return it;
}

function itensPedidoFromVencedores(fid) {
  const bloco = pedidosCompraPorFornecedor(fid)[0];
  if (!bloco) return [];
  return bloco.itens.map(({ p, qtde, best, total }) =>
    recalcularItemPedido({
      produtoId: p.id,
      nome: p.nome,
      unidade: p.unidade || "",
      qtde,
      preco: best.preco,
      total,
    })
  );
}

function buildPedidoDraft(fornecedorId, existingId) {
  const existing = existingId
    ? getPedidosFornecedor().find((p) => p.id === existingId)
    : null;
  if (existing) {
    return {
      id: existing.id,
      fornecedorId: existing.fornecedorId,
      criadoEm: existing.criadoEm,
      status: existing.status || "rascunho",
      observacao: existing.observacao || "",
      itens: (existing.itens || []).map((it) => recalcularItemPedido({ ...it })),
    };
  }
  const itens = itensPedidoFromVencedores(fornecedorId);
  return {
    id: uid(),
    fornecedorId,
    criadoEm: new Date().toISOString(),
    status: "rascunho",
    observacao: "",
    itens,
  };
}

function upsertPedidoDraft(status) {
  if (!pedidoDraft) return null;
  pedidoDraft.itens = (pedidoDraft.itens || []).map((it) => recalcularItemPedido({ ...it }));
  pedidoDraft.status = status;
  const list = getPedidosFornecedor();
  const idx = list.findIndex((p) => p.id === pedidoDraft.id);
  const saved = {
    id: pedidoDraft.id,
    fornecedorId: pedidoDraft.fornecedorId,
    criadoEm: pedidoDraft.criadoEm || new Date().toISOString(),
    status,
    observacao: pedidoDraft.observacao || "",
    itens: pedidoDraft.itens.map((it) => ({ ...it })),
  };
  if (status === "emitido") saved.emitidoEm = new Date().toISOString();
  if (idx >= 0) list[idx] = { ...list[idx], ...saved };
  else list.push(saved);
  scheduleSave();
  return saved;
}

function montarPedidoDocumentoEl(pedidoLike) {
  const lista = Array.isArray(pedidoLike) ? pedidoLike : [pedidoLike];
  const hoje = formatDateBR(hojeISO());
  const el = document.createElement("article");
  el.className = "pedido-sheet";
  el.style.display = "block";
  el.style.background = "#fff";
  el.style.color = "#000";
  el.style.padding = "8px";

  const multi = lista.length > 1;
  const titulo = multi
    ? "Pedidos de compra por fornecedor"
    : `Pedido de compra — ${lista[0]?.nome || fornNome(lista[0]?.fornecedorId)}`;

  const body = lista
    .map((ped) => {
      const nome = ped.nome || fornNome(ped.fornecedorId);
      const itens = ped.itens || [];
      const total = ped.total != null ? ped.total : totalItensPedido(itens);
      const rows = itens
        .map((it) => {
          const nomeItem = it.nome || it.p?.nome || "—";
          const un = it.unidade || it.p?.unidade || "";
          const qtde = it.qtde;
          const preco = it.preco ?? it.best?.preco ?? 0;
          const tot = it.total != null ? it.total : Number(qtde) * Number(preco);
          return `<tr>
            <td>${esc(nomeItem)}</td>
            <td>${esc(un)}</td>
            <td>${formatNum(qtde)}</td>
            <td>${formatMoney(preco)}</td>
            <td>${formatMoney(tot)}</td>
          </tr>`;
        })
        .join("");
      const obs = ped.observacao
        ? `<p class="contagem-meta"><strong>Obs.:</strong> ${esc(ped.observacao)}</p>`
        : "";
      return `<section class="pedido-bloco">
        <h3>${esc(nome)}</h3>
        <p class="contagem-meta">${itens.length} item(ns)${ped.status ? ` · ${PEDIDO_STATUS[ped.status] || ped.status}` : ""}</p>
        ${obs}
        <table class="data-table pedido-table">
          <thead>
            <tr>
              <th>Produto</th>
              <th>UN</th>
              <th>Qtde</th>
              <th>Preço unit.</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5">Sem itens</td></tr>'}</tbody>
          <tfoot>
            <tr class="totals-row">
              <td colspan="4"><strong>Total do pedido</strong></td>
              <td><strong>${formatMoney(total)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </section>`;
    })
    .join("");

  el.innerHTML = `
    <header class="pedido-print-header">
      <div>
        <p class="pedido-eyebrow">Aquela Parmê</p>
        <h2>${esc(titulo)}</h2>
        <p class="contagem-meta">Emitido em ${hoje}${multi ? ` · ${lista.length} fornecedor(es)` : ""}</p>
      </div>
    </header>
    <div>${body}</div>
    <footer class="pedido-print-footer">
      <div>
        <p>Assinatura / carimbo comprador</p>
        <div class="pedido-sign-line"></div>
      </div>
      <div>
        <p>Assinatura / carimbo fornecedor</p>
        <div class="pedido-sign-line"></div>
      </div>
    </footer>`;
  return el;
}

/**
 * PDF a partir de dados / HTML montado no host (não usa nó display:none da view).
 */
async function exportPedidoDocumentoPdf(pedidoLike, filename) {
  const lista = Array.isArray(pedidoLike) ? pedidoLike : [pedidoLike];
  const itemCount = lista.reduce((n, p) => n + (p.itens?.length || 0), 0);
  if (!itemCount) {
    alert("Pedido sem itens para exportar.");
    return false;
  }
  document.getElementById("pdf-export-host")?.remove();
  const host = document.createElement("div");
  host.id = "pdf-export-host";
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "190mm",
    maxWidth: "100vw",
    background: "#fff",
    color: "#000",
    zIndex: "0",
    opacity: "0",
    pointerEvents: "none",
    overflow: "visible",
  });
  const sheet = montarPedidoDocumentoEl(lista);
  host.appendChild(sheet);
  document.body.appendChild(host);

  const fnameBase =
    filename ||
    (lista.length === 1
      ? `pedido-${lista[0].nome || fornNome(lista[0].fornecedorId)}-${hojeISO()}`
      : `pedidos-fornecedores-${hojeISO()}`);

  try {
    if (!window.html2pdf) {
      alert('Biblioteca PDF indisponível. Use a impressão do navegador ("Salvar como PDF").');
      document.body.classList.add("printing-pedido");
      const visible = montarPedidoDocumentoEl(lista);
      visible.id = "pedido-print-temp";
      visible.classList.remove("hidden");
      document.body.appendChild(visible);
      window.print();
      window.addEventListener(
        "afterprint",
        () => {
          document.body.classList.remove("printing-pedido");
          visible.remove();
        },
        { once: true }
      );
      return false;
    }
    await waitForNextPaint();
    const text = String(sheet.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || sheet.scrollHeight < 8) {
      alert("Não há conteúdo para gerar o PDF.");
      return false;
    }
    await window
      .html2pdf()
      .set({
        margin: [10, 10, 10, 10],
        filename: `${safePdfFilename(fnameBase)}.pdf`,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: "#ffffff",
          scrollX: 0,
          scrollY: 0,
          windowWidth: Math.max(sheet.scrollWidth, 794),
          windowHeight: Math.max(sheet.scrollHeight, 100),
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        pagebreak: { mode: ["css", "legacy"] },
      })
      .from(sheet)
      .save();
    return true;
  } catch (err) {
    console.error(err);
    alert("Falha ao gerar PDF.");
    return false;
  } finally {
    host.remove();
  }
}

function abrirRevisaoPedido(fornecedorId, existingId) {
  if (!fornecedorId) {
    const filtrado = document.getElementById("filter-res-fornecedor")?.value || "";
    if (!filtrado) {
      alert("Selecione um fornecedor ou use o botão Revisar pedido do fornecedor desejado.");
      return;
    }
    fornecedorId = filtrado;
  }
  pedidoDraft = buildPedidoDraft(fornecedorId, existingId);
  if (!pedidoDraft.itens.length && !existingId) {
    alert("Nenhum item vencedor com qtde > 0 para este fornecedor.");
    pedidoDraft = null;
    return;
  }
  renderModalPedidoRevisao();
}

function renderModalPedidoRevisao() {
  const modal = document.getElementById("modal-pedido");
  if (!modal || !pedidoDraft) return;
  const nome = fornNome(pedidoDraft.fornecedorId);
  document.getElementById("modal-pedido-title").textContent = `Pedido — ${nome}`;
  const total = totalItensPedido(pedidoDraft.itens);
  const body = document.getElementById("modal-pedido-body");
  const readOnly = session.role === "fornecedor";

  const rows = (pedidoDraft.itens || [])
    .map((it, idx) => {
      if (readOnly) {
        return `<tr>
          <td><strong>${esc(it.nome)}</strong></td>
          <td>${esc(it.unidade || "")}</td>
          <td>${formatNum(it.qtde)}</td>
          <td>${formatMoney(it.preco)}</td>
          <td>${formatMoney(it.total)}</td>
          <td></td>
        </tr>`;
      }
      return `<tr data-pedido-idx="${idx}">
        <td><strong>${esc(it.nome)}</strong></td>
        <td>${esc(it.unidade || "")}</td>
        <td><input class="cell-input" data-pedido-field="qtde" data-idx="${idx}" type="number" min="0" step="any" value="${it.qtde}" /></td>
        <td><input class="cell-input" data-pedido-field="preco" data-idx="${idx}" type="number" min="0" step="0.01" value="${it.preco}" /></td>
        <td data-pedido-total="${idx}">${formatMoney(it.total)}</td>
        <td><button class="btn-danger" type="button" data-pedido-rm="${idx}" title="Remover linha">Remover</button></td>
      </tr>`;
    })
    .join("");

  body.innerHTML = `
    <div class="pedido-revisao" id="pedido-revisao-panel">
      <p class="contagem-meta">
        Status: <span class="badge ${pedidoDraft.status === "emitido" || pedidoDraft.status === "visto" ? "badge-ok" : "badge-falta"}">${esc(PEDIDO_STATUS[pedidoDraft.status] || pedidoDraft.status)}</span>
        · Criado em ${formatDateTimeBR(pedidoDraft.criadoEm)}
      </p>
      <div class="table-wrap">
        <table class="data-table" id="table-pedido-revisao">
          <thead>
            <tr>
              <th>Produto</th>
              <th>UN</th>
              <th>Qtde</th>
              <th>Preço</th>
              <th>Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty-state">Sem itens</td></tr>'}</tbody>
          <tfoot>
            <tr class="totals-row">
              <td colspan="4"><strong>Total</strong></td>
              <td id="pedido-revisao-total"><strong>${formatMoney(total)}</strong></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <label class="field" style="margin-top:0.75rem">
        <span>Observação</span>
        <textarea id="pedido-revisao-obs" rows="2" ${readOnly ? "readonly" : ""}>${esc(pedidoDraft.observacao || "")}</textarea>
      </label>
    </div>`;

  const footer = document.getElementById("modal-pedido-footer");
  if (readOnly) {
    footer.innerHTML = `
      <button class="btn btn-ghost" type="button" id="btn-pedido-modal-fechar">Fechar</button>
      <button class="btn" type="button" id="btn-pedido-modal-pdf">Exportar PDF</button>`;
  } else {
    footer.innerHTML = `
      <button class="btn btn-ghost" type="button" id="btn-pedido-modal-fechar">Fechar</button>
      <button class="btn btn-ghost" type="button" id="btn-pedido-modal-pdf">Exportar PDF</button>
      <button class="btn btn-ghost" type="button" id="btn-pedido-modal-rascunho">Salvar rascunho</button>
      <button class="btn" type="button" id="btn-pedido-modal-emitir">Emitir para o fornecedor</button>`;
  }

  if (!readOnly) {
    body.querySelectorAll("[data-pedido-field]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const idx = Number(inp.dataset.idx);
        const field = inp.dataset.pedidoField;
        if (!pedidoDraft.itens[idx]) return;
        pedidoDraft.itens[idx][field] = Number(inp.value) || 0;
        recalcularItemPedido(pedidoDraft.itens[idx]);
        const totCell = body.querySelector(`[data-pedido-total="${idx}"]`);
        if (totCell) totCell.textContent = formatMoney(pedidoDraft.itens[idx].total);
        const totEl = document.getElementById("pedido-revisao-total");
        if (totEl) totEl.innerHTML = `<strong>${formatMoney(totalItensPedido(pedidoDraft.itens))}</strong>`;
      });
    });
    body.querySelectorAll("[data-pedido-rm]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.pedidoRm);
        pedidoDraft.itens.splice(idx, 1);
        renderModalPedidoRevisao();
      });
    });
    document.getElementById("pedido-revisao-obs")?.addEventListener("input", (ev) => {
      pedidoDraft.observacao = ev.target.value;
    });
  }

  document.getElementById("btn-pedido-modal-fechar")?.addEventListener("click", () => modal.close());
  document.getElementById("btn-pedido-modal-pdf")?.addEventListener("click", async () => {
    syncPedidoDraftFromForm();
    const payload = {
      ...pedidoDraft,
      nome: fornNome(pedidoDraft.fornecedorId),
      total: totalItensPedido(pedidoDraft.itens),
    };
    await exportPedidoDocumentoPdf(payload);
  });
  document.getElementById("btn-pedido-modal-rascunho")?.addEventListener("click", () => {
    syncPedidoDraftFromForm();
    if (!pedidoDraft.itens.length) {
      alert("Inclua ao menos um item no pedido.");
      return;
    }
    upsertPedidoDraft("rascunho");
    alert("Rascunho salvo.");
    renderModalPedidoRevisao();
    if (document.querySelector(".view.active")?.id === "view-pedidos") renderPedidos();
  });
  document.getElementById("btn-pedido-modal-emitir")?.addEventListener("click", () => {
    syncPedidoDraftFromForm();
    if (!pedidoDraft.itens.length) {
      alert("Inclua ao menos um item no pedido.");
      return;
    }
    const withQty = pedidoDraft.itens.filter((it) => Number(it.qtde) > 0);
    if (!withQty.length) {
      alert("Informe quantidade > 0 em pelo menos um item.");
      return;
    }
    pedidoDraft.itens = withQty.map((it) => recalcularItemPedido({ ...it }));
    const saved = upsertPedidoDraft("emitido");
    alert(
      `Pedido emitido para ${fornNome(saved.fornecedorId)}. O fornecedor verá em Meus pedidos ao entrar no sistema.`
    );
    modal.close();
    pedidoDraft = null;
    if (can("pedidos")) renderPedidos();
    if (can("resultado")) renderResultado();
  });

  const closeBtn = document.getElementById("modal-pedido-close");
  if (closeBtn) closeBtn.onclick = () => modal.close();
  if (!modal.open) modal.showModal();
}

function syncPedidoDraftFromForm() {
  if (!pedidoDraft) return;
  const obs = document.getElementById("pedido-revisao-obs");
  if (obs) pedidoDraft.observacao = obs.value;
  document.querySelectorAll("#table-pedido-revisao [data-pedido-field]").forEach((inp) => {
    const idx = Number(inp.dataset.idx);
    const field = inp.dataset.pedidoField;
    if (!pedidoDraft.itens[idx]) return;
    pedidoDraft.itens[idx][field] = Number(inp.value) || 0;
    recalcularItemPedido(pedidoDraft.itens[idx]);
  });
}

function abrirDetalhePedido(pedidoId) {
  const ped = getPedidosFornecedor().find((p) => p.id === pedidoId);
  if (!ped) return;
  if (session.role === "fornecedor" && ped.fornecedorId !== session.fornecedorId) return;
  if (session.role === "fornecedor" && ped.status === "emitido") {
    ped.status = "visto";
    ped.vistoEm = new Date().toISOString();
    scheduleSave();
  }
  pedidoDraft = {
    id: ped.id,
    fornecedorId: ped.fornecedorId,
    criadoEm: ped.criadoEm,
    status: ped.status,
    observacao: ped.observacao || "",
    itens: (ped.itens || []).map((it) => recalcularItemPedido({ ...it })),
  };
  renderModalPedidoRevisao();
  if (document.querySelector(".view.active")?.id === "view-pedidos") renderPedidos();
}

function renderPedidos() {
  const list = document.getElementById("pedidos-lista");
  const kpis = document.getElementById("pedidos-kpis");
  if (!list) return;

  const filtersAdmin = document.getElementById("pedidos-filters-admin");
  const hint = document.getElementById("pedidos-hint");
  if (filtersAdmin) filtersAdmin.classList.toggle("hidden", session.role !== "admin");
  if (hint) {
    hint.textContent =
      session.role === "fornecedor"
        ? "Pedidos emitidos para você pela administração."
        : "Histórico de pedidos. Em Resultado use Revisar pedido para criar e emitir.";
  }

  let pedidos = [...getPedidosFornecedor()];
  if (session.role === "fornecedor") {
    pedidos = pedidos.filter(
      (p) => p.fornecedorId === session.fornecedorId && p.status !== "rascunho"
    );
  } else {
    const filtro = document.getElementById("filter-pedidos-status")?.value || "";
    const forn = document.getElementById("filter-pedidos-fornecedor")?.value || "";
    if (filtro) pedidos = pedidos.filter((p) => p.status === filtro);
    if (forn) pedidos = pedidos.filter((p) => p.fornecedorId === forn);
  }

  pedidos.sort((a, b) => String(b.criadoEm || "").localeCompare(String(a.criadoEm || "")));

  const todos = getPedidosFornecedor();
  const scoped =
    session.role === "fornecedor"
      ? todos.filter((p) => p.fornecedorId === session.fornecedorId && p.status !== "rascunho")
      : todos;
  if (kpis) {
    const emitidos = scoped.filter((p) => p.status === "emitido").length;
    const vistos = scoped.filter((p) => p.status === "visto").length;
    const rasc = session.role === "admin" ? scoped.filter((p) => p.status === "rascunho").length : 0;
    kpis.innerHTML = `
      <article class="kpi-card"><p class="kpi-label">Pedidos</p><p class="kpi-value">${scoped.length}</p></article>
      <article class="kpi-card"><p class="kpi-label">Emitidos</p><p class="kpi-value kpi-warn">${emitidos}</p></article>
      <article class="kpi-card"><p class="kpi-label">Vistos</p><p class="kpi-value kpi-success">${vistos}</p></article>
      ${
        session.role === "admin"
          ? `<article class="kpi-card"><p class="kpi-label">Rascunhos</p><p class="kpi-value">${rasc}</p></article>`
          : ""
      }`;
  }

  const fornSel = document.getElementById("filter-pedidos-fornecedor");
  if (fornSel && session.role === "admin") {
    const prev = fornSel.value;
    fornSel.innerHTML =
      `<option value="">Todos os fornecedores</option>` +
      getFornecedores().map((f) => `<option value="${f.id}">${esc(f.nome)}</option>`).join("");
    if (prev && [...fornSel.options].some((o) => o.value === prev)) fornSel.value = prev;
  }

  if (!pedidos.length) {
    list.innerHTML =
      session.role === "fornecedor"
        ? '<p class="empty-state">Nenhum pedido emitido para você ainda.</p>'
        : '<p class="empty-state">Nenhum pedido neste filtro. Em Resultado, use <strong>Revisar pedido</strong> e emita.</p>';
    return;
  }

  list.innerHTML = pedidos
    .map((ped) => {
      const st = ped.status || "rascunho";
      const badge =
        st === "visto" ? "badge-ok" : st === "emitido" ? "badge-falta" : "badge-inativo";
      const total = totalItensPedido(ped.itens);
      const n = (ped.itens || []).length;
      return `<article class="pedido-card">
        <div class="pedido-card-main">
          <div>
            <strong>${esc(fornNome(ped.fornecedorId))}</strong>
            <p class="contagem-meta">${formatDateTimeBR(ped.criadoEm)} · ${n} item(ns) · ${formatMoney(total)}</p>
          </div>
          <span class="badge ${badge}">${esc(PEDIDO_STATUS[st] || st)}</span>
        </div>
        <div class="pedido-card-actions">
          <button class="btn btn-sm" type="button" data-pedido-abrir="${escAttr(ped.id)}">Abrir</button>
          <button class="btn btn-ghost btn-sm" type="button" data-pedido-pdf="${escAttr(ped.id)}">PDF</button>
        </div>
      </article>`;
    })
    .join("");

  list.querySelectorAll("[data-pedido-abrir]").forEach((btn) => {
    btn.addEventListener("click", () => abrirDetalhePedido(btn.dataset.pedidoAbrir));
  });
  list.querySelectorAll("[data-pedido-pdf]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ped = getPedidosFornecedor().find((p) => p.id === btn.dataset.pedidoPdf);
      if (!ped) return;
      await exportPedidoDocumentoPdf({
        ...ped,
        nome: fornNome(ped.fornecedorId),
        total: totalItensPedido(ped.itens),
      });
    });
  });
}

function montarPedidoCompraSheet() {
  const fornId = document.getElementById("filter-res-fornecedor")?.value || "";
  const pedidos = pedidosCompraPorFornecedor(fornId);
  if (!pedidos.length) {
    alert(
      fornId
        ? "Nenhum item vencedor com qtde > 0 para este fornecedor."
        : "Nenhum item vencedor com qtde > 0. Ajuste o filtro ou as cotações."
    );
    return null;
  }
  const fname =
    pedidos.length === 1
      ? `pedido-${pedidos[0].nome}-${hojeISO()}`
      : `pedidos-fornecedores-${hojeISO()}`;
  return { pedidos, filename: fname };
}

async function emitirPedidoCompra(modo = "pdf") {
  const built = montarPedidoCompraSheet();
  if (!built) return;
  const { pedidos, filename } = built;
  if (modo === "print") {
    document.getElementById("pdf-export-host")?.remove();
    const sheet = montarPedidoDocumentoEl(pedidos);
    sheet.id = "pedido-print-temp";
    document.body.appendChild(sheet);
    document.body.classList.add("printing-pedido");
    window.print();
    window.addEventListener(
      "afterprint",
      () => {
        document.body.classList.remove("printing-pedido");
        sheet.remove();
      },
      { once: true }
    );
    return;
  }
  await exportPedidoDocumentoPdf(pedidos, filename);
}

/* ── Valores (estoque × cotação + histórico/inflação) ── */
let valoresTab = "estoque";

function switchValoresTab(tab) {
  valoresTab = ["estoque", "historico", "inflacao"].includes(tab) ? tab : "estoque";
  document.querySelectorAll("[data-valores-tab]").forEach((b) => {
    b.classList.toggle("active", b.dataset.valoresTab === valoresTab);
  });
  document.querySelectorAll("[data-valores-panel]").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.valoresPanel !== valoresTab);
  });
  if (valoresTab === "historico") renderHistoricoPrecos();
  else if (valoresTab === "inflacao") renderInflacao();
  else renderValoresEstoque();
}

function renderValores() {
  // auto-seed first snapshot so inflation/history have a starting point
  if (!(state.historicoPrecos || []).length) {
    const comPreco = produtosAtivos().some((p) => precoReferencia(p.id) > 0);
    if (comPreco) snapshotPrecosAtual("Carga inicial de preços");
  }
  switchValoresTab(valoresTab);
}

function renderValoresEstoque() {
  const lojaFiltro =
    session.role === "loja"
      ? session.lojaId
      : document.getElementById("filter-valores-loja")?.value || "";
  const busca = document.getElementById("filter-valores-busca")?.value.toLowerCase() || "";
  const soSaldo = document.getElementById("filter-valores-so-saldo")?.checked !== false;
  const base = getSnapshotById(document.getElementById("filter-inflacao-base")?.value) || ultimoSnapshotPrecos();

  const lojas =
    session.role === "loja"
      ? getLojas().filter((l) => l.id === session.lojaId)
      : getLojas();

  let totalGeral = 0;
  let semPrecoGeral = 0;
  let comPreco = 0;
  const tbodyLojas = document.querySelector("#table-valores-lojas tbody");
  if (!tbodyLojas) return;

  tbodyLojas.innerHTML = lojas
    .map((l) => {
      const v = valorEstoqueLoja(l.id);
      totalGeral += v.valor;
      semPrecoGeral += v.semPreco;
      comPreco += Math.max(0, v.itensComSaldo - v.semPreco);
      return `<tr>
        <td><strong>${esc(l.nome)}</strong></td>
        <td>${v.itensComSaldo}</td>
        <td>${v.semPreco ? `<span class="badge badge-falta">${v.semPreco}</span>` : "0"}</td>
        <td><strong>${formatMoney(v.valor)}</strong></td>
      </tr>`;
    })
    .join("");

  const totalEl = document.getElementById("valores-total-geral");
  if (totalEl) totalEl.textContent = formatMoney(totalGeral);

  const kpis = document.getElementById("valores-kpis");
  if (kpis) {
    kpis.innerHTML = `
      <article class="kpi-card"><p class="kpi-label">Total geral</p><p class="kpi-value">${formatMoney(totalGeral)}</p></article>
      <article class="kpi-card"><p class="kpi-label">Itens valorizados</p><p class="kpi-value kpi-success">${comPreco}</p></article>
      <article class="kpi-card"><p class="kpi-label">Sem preço</p><p class="kpi-value ${semPrecoGeral ? "kpi-warn" : ""}">${semPrecoGeral}</p></article>
      <article class="kpi-card"><p class="kpi-label">Snapshots</p><p class="kpi-value">${(state.historicoPrecos || []).length}</p></article>`;
  }

  const lojaIdsDetalhe = lojaFiltro ? [lojaFiltro] : lojas.map((l) => l.id);
  const titulo = document.getElementById("valores-detalhe-titulo");
  if (titulo) {
    titulo.textContent = lojaFiltro
      ? `Detalhe — ${lojaNome(lojaFiltro)}`
      : "Detalhe por produto (todas as lojas)";
  }

  let subtotal = 0;
  const linhas = [];
  produtosAtivos()
    .filter(
      (p) =>
        !busca ||
        p.nome.toLowerCase().includes(busca) ||
        p.categoria.toLowerCase().includes(busca)
    )
    .forEach((p) => {
      let saldo = 0;
      lojaIdsDetalhe.forEach((lid) => {
        saldo += Number(ensureEstoque(lid, p.id).saldo) || 0;
      });
      if (soSaldo && saldo <= 0) return;
      const info = precoReferenciaInfo(p.id);
      const preco = info.preco || 0;
      const valor = preco > 0 ? saldo * preco : 0;
      if (preco > 0) subtotal += valor;
      const precoBase = Number(base?.precos?.[p.id]?.preco) || 0;
      const idx = precoBase > 0 && preco > 0 ? indiceInflacao(precoBase, preco) : null;
      linhas.push({ p, saldo, info, preco, valor, idx });
    });

  const tbodyItens = document.querySelector("#table-valores-itens tbody");
  if (!tbodyItens) return;
  tbodyItens.innerHTML = linhas.length
    ? linhas
        .map(({ p, saldo, info, preco, valor, idx }) => {
          const idxCls = idx == null ? "" : idx > 0 ? "kpi-danger" : idx < 0 ? "kpi-success" : "";
          return `<tr class="${preco <= 0 && saldo > 0 ? "row-atencao" : ""}">
      <td><strong>${esc(p.nome)}</strong></td>
      <td>${esc(p.categoria)}</td>
      <td>${esc(p.unidade)}</td>
      <td>${formatNum(saldo)}</td>
      <td>${preco > 0 ? formatMoney(preco) : "—"}</td>
      <td>${preco > 0 ? `${esc(info.fonte)}${info.nome ? ` · ${esc(info.nome)}` : ""}` : "—"}</td>
      <td><strong>${preco > 0 ? formatMoney(valor) : "—"}</strong></td>
      <td class="${idxCls}">${formatPct(idx)}</td>
    </tr>`;
        })
        .join("")
    : '<tr><td colspan="8" class="empty-state">Nenhum item neste filtro</td></tr>';
  const sub = document.getElementById("valores-subtotal");
  if (sub) sub.textContent = formatMoney(subtotal);
}

function renderHistoricoPrecos() {
  const tbody = document.querySelector("#table-historico-precos tbody");
  if (!tbody) return;
  const list = state.historicoPrecos || [];
  tbody.innerHTML = list.length
    ? list
        .map(
          (s) => `<tr data-snap="${s.id}">
      <td>${formatDateTimeBR(s.data)}</td>
      <td>${esc(s.label || "—")}</td>
      <td>${s.itens || Object.keys(s.precos || {}).length}</td>
      <td>${formatMoney(s.totalGeral || 0)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-use-base="${s.id}" type="button">Usar como base</button>
        <button class="btn-danger btn-sm" data-del-snap="${s.id}" type="button">Excluir</button>
      </td>
    </tr>`
        )
        .join("")
    : '<tr><td colspan="5" class="empty-state">Nenhum snapshot ainda. Clique em “Salvar preços atuais”.</td></tr>';

  tbody.querySelectorAll("[data-use-base]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sel = document.getElementById("filter-inflacao-base");
      if (sel) sel.value = btn.dataset.useBase;
      valoresTab = "inflacao";
      switchValoresTab("inflacao");
    });
  });
  tbody.querySelectorAll("[data-del-snap]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!confirm("Excluir este snapshot do histórico?")) return;
      state.historicoPrecos = (state.historicoPrecos || []).filter((s) => s.id !== btn.dataset.delSnap);
      scheduleSave();
      renderHistoricoPrecos();
    });
  });
}

function renderInflacao() {
  const sel = document.getElementById("filter-inflacao-base");
  const list = state.historicoPrecos || [];
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = list.length
      ? list
          .map(
            (s) =>
              `<option value="${s.id}">${esc(s.label || formatDateBR(String(s.data).slice(0, 10)))} (${formatDateBR(String(s.data).slice(0, 10))})</option>`
          )
          .join("")
      : `<option value="">Sem histórico</option>`;
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }
  const base = getSnapshotById(sel?.value) || list[0] || null;
  const rows = [];
  let sumIdx = 0;
  let nIdx = 0;
  let altas = 0;
  let baixas = 0;

  produtosAtivos().forEach((p) => {
    const atual = precoReferencia(p.id);
    const precoBase = Number(base?.precos?.[p.id]?.preco) || 0;
    if (atual <= 0 && precoBase <= 0) return;
    const idx = indiceInflacao(precoBase, atual);
    if (idx != null) {
      sumIdx += idx;
      nIdx += 1;
      if (idx > 0.05) altas += 1;
      if (idx < -0.05) baixas += 1;
    }
    rows.push({ p, precoBase, atual, idx, delta: atual && precoBase ? atual - precoBase : null });
  });

  rows.sort((a, b) => Math.abs(b.idx || 0) - Math.abs(a.idx || 0));
  const media = nIdx ? sumIdx / nIdx : null;

  const kpis = document.getElementById("inflacao-kpis");
  if (kpis) {
    kpis.innerHTML = `
      <article class="kpi-card"><p class="kpi-label">Índice médio</p><p class="kpi-value ${media != null && media > 0 ? "kpi-danger" : media != null && media < 0 ? "kpi-success" : ""}">${formatPct(media)}</p></article>
      <article class="kpi-card"><p class="kpi-label">Itens em alta</p><p class="kpi-value kpi-danger">${altas}</p></article>
      <article class="kpi-card"><p class="kpi-label">Itens em baixa</p><p class="kpi-value kpi-success">${baixas}</p></article>
      <article class="kpi-card"><p class="kpi-label">Comparados</p><p class="kpi-value">${nIdx}</p></article>`;
  }

  const tbody = document.querySelector("#table-inflacao tbody");
  if (!tbody) return;
  if (!base) {
    tbody.innerHTML =
      '<tr><td colspan="5" class="empty-state">Salve um snapshot em Histórico para calcular o índice.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.length
    ? rows
        .map(({ p, precoBase, atual, idx, delta }) => {
          const cls = idx == null ? "" : idx > 0 ? "row-atencao" : idx < 0 ? "row-ok" : "";
          return `<tr class="${cls}">
        <td><strong>${esc(p.nome)}</strong></td>
        <td>${precoBase > 0 ? formatMoney(precoBase) : "—"}</td>
        <td>${atual > 0 ? formatMoney(atual) : "—"}</td>
        <td>${delta == null ? "—" : formatMoney(delta)}</td>
        <td><strong>${formatPct(idx)}</strong></td>
      </tr>`;
        })
        .join("")
    : '<tr><td colspan="5" class="empty-state">Sem preços para comparar</td></tr>';
}

function salvarSnapshotPrecosUI() {
  const snap = snapshotPrecosAtual();
  alert(
    `Snapshot salvo: ${snap.itens} preços · estoque ${formatMoney(snap.totalGeral)}.\nAgora você pode comparar na aba Inflação.`
  );
  renderValores();
}

/* ── Produtos (CRUD no Estoque Central) ── */
function openProdutoModal(id) {
  const p = id ? getProduto(id) : null;
  const isNew = !p;
  document.getElementById("modal-title").textContent = isNew ? "Novo produto" : "Editar produto";
  document.getElementById("modal-body").innerHTML = `
    <label class="field"><span>Nome</span>
      <input id="p-nome" required type="text" value="${escAttr(p?.nome || "")}" /></label>
    <div class="field-row">
      <label class="field"><span>Categoria</span>
        <input id="p-cat" list="p-cat-list" type="text" value="${escAttr(p?.categoria || "")}" /></label>
      <datalist id="p-cat-list">${categorias()
        .map((c) => `<option value="${escAttr(c)}"></option>`)
        .join("")}</datalist>
      <label class="field"><span>Centro de custo</span>
        <input id="p-cc" type="text" value="${escAttr(p?.centroCusto || "CENTRAL")}" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Unidade</span>
        <input id="p-un" type="text" value="${escAttr(p?.unidade || "UN")}" /></label>
      <label class="field"><span>SKU (opcional)</span>
        <input id="p-sku" type="text" value="${escAttr(p?.sku || "")}" placeholder="Código Nexa / interno" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Ativo</span>
        <select id="p-ativo">
          <option value="1" ${p?.ativo !== false ? "selected" : ""}>Sim</option>
          <option value="0" ${p?.ativo === false ? "selected" : ""}>Não</option>
        </select></label>
    </div>
    ${
      !isNew
        ? `<p class="toolbar-hint">Saldo e mínimo do Central continuam na tabela de estoque.</p>
           <button class="btn-danger" id="p-delete" type="button">Excluir produto…</button>`
        : `<p class="toolbar-hint">O produto entra no Central e em todas as lojas com saldo 0.</p>`
    }`;

  const modal = document.getElementById("modal");
  modal.showModal();
  document.getElementById("p-delete")?.addEventListener("click", () => {
    modal.close();
    confirmDeleteProduto(p.id);
  });
  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    const data = {
      nome: document.getElementById("p-nome").value.trim(),
      categoria: document.getElementById("p-cat").value.trim(),
      centroCusto: document.getElementById("p-cc").value.trim() || "CENTRAL",
      unidade: document.getElementById("p-un").value.trim() || "UN",
      sku: (document.getElementById("p-sku")?.value || "").trim(),
      ativo: document.getElementById("p-ativo").value === "1",
    };
    if (!data.nome) return;
    if (isNew) {
      const pid = uniqueProdutoId(data.nome);
      state.produtos.push({ id: pid, ...data });
      ensureProdutoEverywhere(pid);
    } else {
      Object.assign(p, data);
    }
    modal.close();
    scheduleSave();
    setupRoleFilters();
    render();
  };
}

/* ── Fornecedores ── */
function ensureFornecedorStructures(fid) {
  if (!state.cotacoes[fid]) state.cotacoes[fid] = {};
  state.produtos.forEach((p) => ensureCotacao(fid, p.id));
}

function renderFornecedores() {
  if (session?.role !== "admin") return;
  const tbody = document.querySelector("#table-fornecedores tbody");
  if (!tbody) return;
  tbody.innerHTML = getAllFornecedores()
    .map((f) => {
      const user = state.usuarios.find((u) => u.fornecedorId === f.id && u.role === "fornecedor");
      return `<tr>
        <td><strong>${esc(f.nome)}</strong></td>
        <td><code>${esc(user?.id || f.id)}</code></td>
        <td><code>${esc(user?.password || "—")}</code></td>
        <td><span class="badge badge-${f.ativo !== false ? "ok" : "inativo"}">${f.ativo !== false ? "Ativo" : "Inativo"}</span></td>
        <td>${esc(f.contato || "—")}</td>
        <td>
          <button class="btn btn-ghost btn-sm" data-edit-forn="${f.id}" type="button">Editar</button>
          <button class="btn-danger" data-toggle-forn="${f.id}" type="button">${f.ativo !== false ? "Desativar" : "Reativar"}</button>
        </td>
      </tr>`;
    })
    .join("") || '<tr><td colspan="6" class="empty-state">Nenhum fornecedor</td></tr>';

  tbody.querySelectorAll("[data-edit-forn]").forEach((btn) => {
    btn.addEventListener("click", () => openFornecedorModal(btn.dataset.editForn));
  });
  tbody.querySelectorAll("[data-toggle-forn]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = getAllFornecedores().find((x) => x.id === btn.dataset.toggleForn);
      if (!f) return;
      f.ativo = f.ativo === false;
      scheduleSave();
      setupRoleFilters();
      populateLoginUsers();
      renderFornecedores();
    });
  });
}

function openFornecedorModal(id) {
  const f = id ? getAllFornecedores().find((x) => x.id === id) : null;
  const isNew = !f;
  const user = f ? state.usuarios.find((u) => u.fornecedorId === f.id && u.role === "fornecedor") : null;

  document.getElementById("modal-title").textContent = isNew ? "Novo fornecedor" : "Editar fornecedor";
  document.getElementById("modal-body").innerHTML = `
    <label class="field"><span>Nome do fornecedor</span>
      <input id="f-nome" required type="text" value="${escAttr(f?.nome || "")}" /></label>
    <label class="field"><span>Login (usuário de acesso)</span>
      <input id="f-login" ${isNew ? "" : "readonly"} required type="text" value="${escAttr(user?.id || f?.id || "")}" placeholder="ex: frigorifico-silva" />
      <p class="field-hint">${isNew ? "Deixe em branco para gerar automaticamente a partir do nome." : "Login não pode ser alterado depois."}</p></label>
    <label class="field"><span>Senha de acesso</span>
      <input id="f-pass" required type="text" value="${escAttr(user?.password || "")}" placeholder="mín. 4 caracteres" /></label>
    <label class="field"><span>Contato (opcional)</span>
      <input id="f-contato" type="text" value="${escAttr(f?.contato || "")}" placeholder="telefone, WhatsApp, e-mail…" /></label>`;

  const modal = document.getElementById("modal");
  modal.showModal();

  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    const nome = document.getElementById("f-nome").value.trim();
    let login = document.getElementById("f-login").value.trim().toLowerCase();
    const pass = document.getElementById("f-pass").value.trim();
    const contato = document.getElementById("f-contato").value.trim();
    if (!nome) return;
    if (pass.length < 4) {
      alert("Senha deve ter ao menos 4 caracteres.");
      return;
    }

    if (isNew) {
      if (!login) login = slugify(nome);
      login = slugify(login);
      if (state.usuarios.some((u) => u.id === login) || getAllFornecedores().some((x) => x.id === login)) {
        alert("Já existe um usuário/fornecedor com este login. Escolha outro.");
        return;
      }
      const novo = { id: login, nome, ativo: true, contato };
      state.fornecedores.push(novo);
      ensureFornecedorStructures(login);
      state.usuarios.push({
        id: login,
        nome,
        role: "fornecedor",
        password: pass,
        lojaId: "",
        fornecedorId: login,
      });
    } else {
      f.nome = nome;
      f.contato = contato;
      if (user) {
        user.nome = nome;
        user.password = pass;
      }
    }

    modal.close();
    scheduleSave();
    populateLoginUsers();
    setupRoleFilters();
    render();
    if (isNew) {
      alert(`Fornecedor criado!\n\nLogin: ${login}\nSenha: ${pass}\n\nEnvie estes dados para o fornecedor entrar no sistema.`);
    }
  };
}

/* ── Nuvem ── */
function renderNuvem() {
  if (session?.role !== "admin") return;
  const cfg = getCloudConfig() || { url: "", anonKey: "" };
  document.getElementById("cloud-url").value = cfg.url || "";
  document.getElementById("cloud-key").value = cfg.anonKey || "";
  document.getElementById("cloud-status").textContent = supabaseClient
    ? "Status: conectado — alterações sincronizam em tempo real"
    : "Status: não configurado — dados só neste navegador";
}

async function connectCloudAndSync() {
  const url = document.getElementById("cloud-url").value.trim();
  const key = document.getElementById("cloud-key").value.trim();
  if (!url || !key) {
    alert("Informe URL e anon key do Supabase.");
    return;
  }
  saveCloudConfig(url, key);
  if (!initSupabase()) {
    document.getElementById("cloud-status").textContent = "Status: erro ao conectar — verifique URL/key";
    return;
  }
  const remote = await pullFromCloud();
  if (remote?.payload && Object.keys(remote.payload).length > 1) {
    const useRemote = confirm(
      "Já existem dados na nuvem. Deseja BAIXAR e usar os dados da nuvem neste aparelho?\n\nOK = baixar nuvem\nCancelar = manter locais e enviar para a nuvem"
    );
    if (useRemote) {
      await applyRemoteState(remote.payload, remote.updated_at);
    } else {
      await pushToCloud();
    }
  } else {
    await pushToCloud();
  }
  subscribeCloud();
  renderNuvem();
  alert("Nuvem conectada! Lojas e fornecedores nos outros aparelhos devem usar a mesma URL/key (ou o config.js publicado).");
}

/* ── Usuários ── */
function renderUsuarios() {
  if (session?.role !== "admin") return;
  const hint = document.getElementById("seed-version-hint");
  if (hint) {
    const ver = state.seedVersion || "—";
    hint.textContent = `Dados da planilha (seed): versão ${ver}. O botão abaixo reaplica estoque, cotação e produção mantendo as senhas.`;
  }

  const tbody = document.querySelector("#table-usuarios tbody");
  const usuarios = state.usuarios.filter((u) => u.role !== "fornecedor");
  tbody.innerHTML = usuarios
    .map((u) => {
      const vinculo = u.role === "loja" ? lojaNome(u.lojaId) : "—";
      return `<tr data-uid="${u.id}">
        <td><code>${esc(u.id)}</code></td>
        <td>${esc(u.nome)}</td>
        <td><span class="badge badge-${u.role}">${u.role}</span></td>
        <td>${esc(vinculo)}</td>
        <td><input class="cell-input wide" data-pass type="text" placeholder="nova senha" /></td>
        <td><button class="btn btn-sm" data-save-pass type="button">Salvar senha</button></td>
      </tr>`;
    })
    .join("") || '<tr><td colspan="6" class="empty-state">Nenhum usuário</td></tr>';

  tbody.querySelectorAll("tr[data-uid]").forEach((tr) => {
    tr.querySelector("[data-save-pass]").addEventListener("click", () => {
      const pass = tr.querySelector("[data-pass]").value.trim();
      if (!pass || pass.length < 4) {
        alert("Senha deve ter ao menos 4 caracteres.");
        return;
      }
      const user = state.usuarios.find((u) => u.id === tr.dataset.uid);
      if (user) {
        user.password = pass;
        scheduleSave();
        alert(`Senha de ${user.nome} atualizada.`);
        tr.querySelector("[data-pass]").value = "";
      }
    });
  });
}

/* ── Envio sexta ── */
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function proximoOuAtualFriday(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const add = (5 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + add);
  return d;
}

function formatDateBR(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function weekdayLabel(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("pt-BR", { weekday: "long" });
}

function envioSigStorageKey(lojaId, data) {
  return `${lojaId || "loja"}|${data || "sem-data"}`;
}

function loadEnvioSigStore() {
  try {
    return JSON.parse(localStorage.getItem(ENVIO_SIG_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveEnvioSigStore(store) {
  localStorage.setItem(ENVIO_SIG_KEY, JSON.stringify(store));
}

function getEnvioSigRecord() {
  const lojaId = document.getElementById("filter-envio-loja")?.value || "";
  const data = document.getElementById("filter-envio-data")?.value || "";
  const all = loadEnvioSigStore();
  return all[envioSigStorageKey(lojaId, data)] || {};
}

function persistEnvioSigRecord(patch) {
  const lojaId = document.getElementById("filter-envio-loja")?.value || "";
  const data = document.getElementById("filter-envio-data")?.value || "";
  const key = envioSigStorageKey(lojaId, data);
  const all = loadEnvioSigStore();
  all[key] = { ...(all[key] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveEnvioSigStore(all);
}

function createSigPad(canvas) {
  const ctx = canvas.getContext("2d");
  let drawing = false;
  let dirty = false;

  function pos(ev) {
    const rect = canvas.getBoundingClientRect();
    const src = ev.touches ? ev.touches[0] : ev;
    return {
      x: ((src.clientX - rect.left) / rect.width) * canvas.width,
      y: ((src.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function start(ev) {
    ev.preventDefault();
    drawing = true;
    const p = pos(ev);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function move(ev) {
    if (!drawing) return;
    ev.preventDefault();
    const p = pos(ev);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#1e293b";
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    dirty = true;
  }

  function end(ev) {
    if (!drawing) return;
    ev.preventDefault();
    drawing = false;
    if (dirty) persistCurrentSigs();
  }

  canvas.addEventListener("mousedown", start);
  canvas.addEventListener("mousemove", move);
  canvas.addEventListener("mouseup", end);
  canvas.addEventListener("mouseleave", end);
  canvas.addEventListener("touchstart", start, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", end);

  return {
    canvas,
    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      dirty = false;
    },
    isEmpty() {
      return !dirty;
    },
    toDataURL() {
      if (!dirty) return "";
      return canvas.toDataURL("image/png");
    },
    fromDataURL(dataUrl) {
      this.clear();
      if (!dataUrl) return;
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        dirty = true;
      };
      img.src = dataUrl;
    },
    markDirty() {
      dirty = true;
    },
  };
}

function ensureEnvioSigPads() {
  if (envioSigPads) return envioSigPads;
  const cEnt = document.getElementById("sig-entregador");
  const cLoja = document.getElementById("sig-loja");
  if (!cEnt || !cLoja) return null;
  envioSigPads = {
    entregador: createSigPad(cEnt),
    loja: createSigPad(cLoja),
  };
  return envioSigPads;
}

function persistCurrentSigs() {
  const pads = ensureEnvioSigPads();
  if (!pads) return;
  persistEnvioSigRecord({
    entregadorImg: pads.entregador.toDataURL(),
    lojaImg: pads.loja.toDataURL(),
    entregadorNome: document.getElementById("sig-entregador-nome")?.value || "",
    entregadorData: document.getElementById("sig-entregador-data")?.value || "",
    lojaNome: document.getElementById("sig-loja-nome")?.value || "",
    lojaData: document.getElementById("sig-loja-data")?.value || "",
    checklist: { ...envioChecklist },
  });
}

function restoreEnvioSigs(force = false) {
  const pads = ensureEnvioSigPads();
  if (!pads) return;
  const lojaId = document.getElementById("filter-envio-loja")?.value || "";
  const data = document.getElementById("filter-envio-data")?.value || "";
  const key = envioSigStorageKey(lojaId, data);
  const rec = getEnvioSigRecord();

  if (force || envioSigRestoredKey !== key) {
    pads.entregador.fromDataURL(rec.entregadorImg || "");
    pads.loja.fromDataURL(rec.lojaImg || "");
    const en = document.getElementById("sig-entregador-nome");
    const ed = document.getElementById("sig-entregador-data");
    const ln = document.getElementById("sig-loja-nome");
    const ld = document.getElementById("sig-loja-data");
    if (en) en.value = rec.entregadorNome || "";
    if (ed) ed.value = rec.entregadorData || data || "";
    if (ln) ln.value = rec.lojaNome || "";
    if (ld) ld.value = rec.lojaData || data || "";
    envioChecklist = { ...(rec.checklist || {}) };
    envioSigRestoredKey = key;
  }
}

function clearEnvioSigs(which) {
  const pads = ensureEnvioSigPads();
  if (!pads) return;
  if (!which || which === "entregador") {
    pads.entregador.clear();
    const en = document.getElementById("sig-entregador-nome");
    const ed = document.getElementById("sig-entregador-data");
    if (en) en.value = "";
    if (ed) ed.value = document.getElementById("filter-envio-data")?.value || "";
  }
  if (!which || which === "loja") {
    pads.loja.clear();
    const ln = document.getElementById("sig-loja-nome");
    const ld = document.getElementById("sig-loja-data");
    if (ln) ln.value = "";
    if (ld) ld.value = document.getElementById("filter-envio-data")?.value || "";
  }
  if (!which) envioChecklist = {};
  persistCurrentSigs();
  envioSigRestoredKey = "";
}

function collectEnvioRows(lojaId) {
  const soQty = document.getElementById("filter-envio-so-qty")?.checked;
  const sugerir = document.getElementById("filter-envio-sugerir")?.checked;
  return produtosDaLoja(lojaId)
    .map((p) => {
      const e = ensureEstoque(lojaId, p.id);
      const envio = Number(e.envio || 0);
      const necessidade = Math.max(0, Number(e.minimo || 0) - Number(e.saldo || 0));
      let qtde = envio;
      let obs = "";
      if (envio <= 0 && sugerir && necessidade > 0) {
        qtde = necessidade;
        obs = "Sugestão (mín − saldo)";
      }
      return { p, e, qtde, obs, envio, necessidade };
    })
    .filter((x) => (soQty ? x.qtde > 0 : x.qtde > 0 || x.necessidade > 0 || x.envio > 0))
    .sort((a, b) => a.p.categoria.localeCompare(b.p.categoria) || a.p.nome.localeCompare(b.p.nome));
}

function getEnvioAplicadoKey(lojaId, data) {
  return envioSigStorageKey(lojaId, data);
}

function getEnvioAplicadoRecord(lojaId, data) {
  if (!state.enviosAplicados || typeof state.enviosAplicados !== "object") return null;
  return state.enviosAplicados[getEnvioAplicadoKey(lojaId, data)] || null;
}

function isEnvioAplicado(lojaId, data) {
  return !!getEnvioAplicadoRecord(lojaId, data)?.aplicado;
}

/** Baixa Central → entrada loja destino (envio semanal). Idempotente por loja+data. */
function confirmarEnvioSexta() {
  if (!canManageEnvio()) {
    alert("Somente Admin ou Estoque Central podem confirmar o envio.");
    return;
  }
  const lojaId = document.getElementById("filter-envio-loja")?.value || "";
  const dataIso = document.getElementById("filter-envio-data")?.value || "";
  if (!lojaId || lojaId === "central") {
    alert("Selecione a loja de destino (não Central).");
    return;
  }
  if (!dataIso) {
    alert("Informe a data do envio.");
    return;
  }
  if (isEnvioAplicado(lojaId, dataIso)) {
    const rec = getEnvioAplicadoRecord(lojaId, dataIso);
    alert(
      `Este envio já foi aplicado em ${formatDateTimeBR(rec.aplicadoAt)}.\n` +
        "Não há nova movimentação de estoque."
    );
    return;
  }

  // Só o campo Envio explícito (não usa “sugerir necessidade”)
  const rows = collectEnvioRows(lojaId).filter((x) => Number(x.envio) > 0);
  if (!rows.length) {
    alert("Nenhum item com quantidade de envio > 0 no Estoque da loja.");
    return;
  }

  const faltando = [];
  rows.forEach(({ p, envio }) => {
    const qtde = Number(envio) || 0;
    const centralEst = ensureEstoque("central", p.id);
    if (qtde > Number(centralEst.saldo || 0)) {
      faltando.push(
        `${p.nome}: Central ${formatNum(centralEst.saldo)} / precisa ${formatNum(qtde)}`
      );
    }
  });
  if (faltando.length) {
    const ok = confirm(
      `Atenção: Central sem saldo suficiente em alguns itens:\n\n` +
        faltando.join("\n") +
        "\n\nConfirmar mesmo assim (Central pode ficar negativo)?"
    );
    if (!ok) return;
  } else if (
    !confirm(
      `Confirmar envio?\n` +
        `Estoque Central → ${lojaNome(lojaId)}\n` +
        `${rows.length} item(ns) — saída no Central e entrada na loja.`
    )
  ) {
    return;
  }

  const itensAplicados = [];
  rows.forEach(({ p, envio }) => {
    const q = Math.max(0, Number(envio) || 0);
    if (!q) return;
    const centralEst = ensureEstoque("central", p.id);
    const destinoEst = ensureEstoque(lojaId, p.id);
    const deCentral = Number(centralEst.saldo || 0);
    const deDest = Number(destinoEst.saldo || 0);
    centralEst.saldo = Math.round((deCentral - q) * 1000) / 1000;
    destinoEst.saldo = Math.round((deDest + q) * 1000) / 1000;
    destinoEst.envio = 0;
    pushMovimento({
      lojaId: "central",
      produtoId: p.id,
      de: deCentral,
      para: centralEst.saldo,
      motivo: "envio",
      nota: `Envio → ${lojaNome(lojaId)} (${dataIso})`,
      tipo: "envio",
    });
    pushMovimento({
      lojaId,
      produtoId: p.id,
      de: deDest,
      para: destinoEst.saldo,
      motivo: "envio",
      nota: `Recebido do Central (${dataIso})`,
      tipo: "envio",
    });
    itensAplicados.push({ produtoId: p.id, qtde: q });
  });

  if (!state.enviosAplicados) state.enviosAplicados = {};
  const key = getEnvioAplicadoKey(lojaId, dataIso);
  const aplicadoAt = new Date().toISOString();
  state.enviosAplicados[key] = {
    aplicado: true,
    lojaId,
    data: dataIso,
    aplicadoAt,
    aplicadoPor: session.userId,
    itens: itensAplicados,
  };
  persistEnvioSigRecord({ aplicado: true, aplicadoAt });
  scheduleSave();
  renderEnvioSexta();
  alert(`Envio aplicado: Central → ${lojaNome(lojaId)} (${itensAplicados.length} itens). Quantidades de envio zeradas.`);
}

function renderEnvioSexta() {
  setupEnvioLojaFilter();
  const lojaId = document.getElementById("filter-envio-loja")?.value || "";
  const dataIso = document.getElementById("filter-envio-data")?.value || toISODate(proximoOuAtualFriday());
  const dataEl = document.getElementById("filter-envio-data");
  if (dataEl && !dataEl.value) dataEl.value = dataIso;

  const loja = lojaNome(lojaId);
  const aplicado = isEnvioAplicado(lojaId, dataIso);
  const meta = document.getElementById("envio-sheet-meta");
  const dateEl = document.getElementById("envio-sheet-date");
  const badgeEl = document.getElementById("envio-aplicado-badge");
  if (meta) {
    meta.textContent = aplicado
      ? `Loja destino: ${loja} · Estoque aplicado (Central → loja)`
      : `Loja destino: ${loja}`;
  }
  if (dateEl) {
    const wd = weekdayLabel(dataIso);
    dateEl.textContent = `${formatDateBR(dataIso)}${wd ? ` · ${wd}` : ""}`;
  }
  if (badgeEl) {
    if (aplicado) {
      const rec = getEnvioAplicadoRecord(lojaId, dataIso);
      badgeEl.classList.remove("hidden");
      badgeEl.textContent = `Aplicado em ${formatDateTimeBR(rec?.aplicadoAt)}`;
    } else {
      badgeEl.classList.add("hidden");
      badgeEl.textContent = "";
    }
  }

  const hint = document.getElementById("envio-hint");
  if (hint) {
    if (aplicado) {
      const rec = getEnvioAplicadoRecord(lojaId, dataIso);
      hint.textContent = `Envio já aplicado em ${formatDateTimeBR(rec?.aplicadoAt)} — estoque Central debitado, loja creditada e quantidades de envio zeradas.`;
    } else if (canManageEnvio()) {
      hint.textContent =
        "Liste o envio por loja, colete as assinaturas e clique em Confirmar envio para baixar o Central e entrar na loja.";
    } else {
      hint.textContent = "Conferência do recebimento da sua loja — assine após conferir os itens.";
    }
  }

  const btnConf = document.getElementById("btn-envio-confirmar");
  if (btnConf) {
    btnConf.classList.toggle("hidden", !canManageEnvio());
    btnConf.disabled = aplicado || lojaId === "central" || !lojaId;
    btnConf.textContent = aplicado ? "Envio já aplicado" : "Confirmar envio";
  }

  restoreEnvioSigs();

  const rows = collectEnvioRows(lojaId);
  const tbody = document.querySelector("#table-envio-sexta tbody");
  if (!tbody) return;

  tbody.innerHTML = rows.length
    ? rows
        .map(({ p, e, qtde, obs }) => {
          const checked = envioChecklist[p.id] ? "checked" : "";
          return `<tr data-pid="${p.id}">
            <td class="col-check">
              <input class="no-print" data-check-envio type="checkbox" ${checked} />
              <span class="check-print" aria-hidden="true"></span>
            </td>
            <td class="col-sticky-produto"><strong>${esc(p.nome)}</strong></td>
            <td>${esc(p.categoria)}</td>
            <td>${esc(p.unidade)}</td>
            <td>${formatNum(e.saldo)}</td>
            <td class="qty-envio">${formatNum(qtde)}</td>
            <td>${obs ? `<span class="envio-sugestao">${esc(obs)}</span>` : ""}</td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="7" class="empty-state">Nenhum item para envio. Preencha o campo Envio no Estoque da loja, ou ative “Sugerir necessidade”.</td></tr>';

  tbody.querySelectorAll("[data-check-envio]").forEach((input) => {
    input.addEventListener("change", () => {
      const pid = input.closest("tr")?.dataset.pid;
      if (!pid) return;
      if (input.checked) envioChecklist[pid] = true;
      else delete envioChecklist[pid];
      persistCurrentSigs();
    });
  });
}

function bindEnvioEvents() {
  const refresh = () => can("envio-sexta") && renderEnvioSexta();
  ["filter-envio-loja", "filter-envio-data", "filter-envio-so-qty", "filter-envio-sugerir"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", () => {
      if (id === "filter-envio-loja" || id === "filter-envio-data") {
        envioSigRestoredKey = "";
        envioChecklist = {};
      }
      refresh();
    });
  });

  document.getElementById("btn-envio-print")?.addEventListener("click", () => {
    persistCurrentSigs();
    window.print();
  });

  document.getElementById("btn-envio-pdf")?.addEventListener("click", async () => {
    persistCurrentSigs();
    const lojaId = document.getElementById("filter-envio-loja")?.value || "loja";
    const data = document.getElementById("filter-envio-data")?.value || hojeISO();
    const sheet = document.getElementById("envio-print-sheet");
    await exportElementToPdf(sheet, `envio-${lojaNome(lojaId)}-${data}`);
  });

  document.getElementById("btn-envio-confirmar")?.addEventListener("click", () => {
    confirmarEnvioSexta();
  });

  document.getElementById("btn-envio-limpar-sigs")?.addEventListener("click", () => {
    if (!confirm("Limpar assinaturas e checklist salvos desta loja/data?")) return;
    clearEnvioSigs();
    renderEnvioSexta();
  });

  document.querySelectorAll("[data-clear-sig]").forEach((btn) => {
    btn.addEventListener("click", () => {
      clearEnvioSigs(btn.dataset.clearSig);
    });
  });

  ["sig-entregador-nome", "sig-entregador-data", "sig-loja-nome", "sig-loja-data"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", persistCurrentSigs);
    document.getElementById(id)?.addEventListener("input", persistCurrentSigs);
  });

  ensureEnvioSigPads();
}

/* ── Emergência (pedidos mid-week) ── */
let emergenciaDraftItens = [];

function formatDateTimeBR(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function enviarSolicitacaoEmergencia(solId) {
  const sol = getSolicitacoesEmergencia().find((s) => s.id === solId);
  if (!sol || sol.status !== "pendente") return;
  if (!canManageEmergencia()) {
    alert("Somente Admin ou Estoque Central podem enviar.");
    return;
  }

  const origemSel = document.querySelector(`[data-emerg-origem="${solId}"]`);
  const origemLojaId = origemSel?.value || sol.origemLojaId || "central";
  const origensValidas = getOrigensEmergencia().map((l) => l.id);
  if (!origensValidas.includes(origemLojaId)) {
    alert("Selecione a origem (Saindo de).");
    return;
  }
  if (origemLojaId === sol.lojaId) {
    const okMesma = confirm(
      `Atenção: origem e destino são a mesma loja (${lojaNome(sol.lojaId)}).\n` +
        "O saldo na loja não muda (saída e entrada se anulam), mas o pedido será marcado como Enviada.\n\nContinuar?"
    );
    if (!okMesma) return;
  }

  const nomeOrigem = lojaNome(origemLojaId);
  const faltando = [];
  (sol.itens || []).forEach((it) => {
    const origemEst = ensureEstoque(origemLojaId, it.produtoId);
    const qtde = Number(it.qtde) || 0;
    if (qtde > Number(origemEst.saldo || 0)) {
      const p = getProduto(it.produtoId);
      faltando.push(`${p?.nome || it.produtoId}: saldo ${formatNum(origemEst.saldo)} / precisa ${formatNum(qtde)}`);
    }
  });
  if (faltando.length) {
    const ok = confirm(
      `Atenção: ${nomeOrigem} não tem saldo suficiente em alguns itens:\n\n` +
        faltando.join("\n") +
        "\n\nEnviar mesmo assim (saldo pode ficar negativo)?"
    );
    if (!ok) return;
  } else if (
    !confirm(
      `Confirmar envio de emergência?\n` +
        `${nomeOrigem} → ${lojaNome(sol.lojaId)}\n` +
        `Isso dá saída em ${nomeOrigem} e entrada na loja destino.`
    )
  ) {
    return;
  }

  (sol.itens || []).forEach((it) => {
    const qtde = Math.max(0, Number(it.qtde) || 0);
    if (!qtde) return;
    const origemEst = ensureEstoque(origemLojaId, it.produtoId);
    const destinoEst = ensureEstoque(sol.lojaId, it.produtoId);
    const deOrig = Number(origemEst.saldo || 0);
    const deDest = Number(destinoEst.saldo || 0);
    origemEst.saldo = Math.round((deOrig - qtde) * 1000) / 1000;
    destinoEst.saldo = Math.round((deDest + qtde) * 1000) / 1000;
    pushMovimento({
      lojaId: origemLojaId,
      produtoId: it.produtoId,
      de: deOrig,
      para: origemEst.saldo,
      motivo: "emergencia",
      nota: `Saída emergência → ${lojaNome(sol.lojaId)}`,
      tipo: "emergencia",
    });
    pushMovimento({
      lojaId: sol.lojaId,
      produtoId: it.produtoId,
      de: deDest,
      para: destinoEst.saldo,
      motivo: "emergencia",
      nota: `Entrada emergência de ${nomeOrigem}`,
      tipo: "emergencia",
    });
  });

  sol.origemLojaId = origemLojaId;
  sol.status = "enviada";
  sol.enviadaAt = new Date().toISOString();
  sol.enviadaPor = session.userId;
  pushHistoricoEmergencia(sol, "enviada", `Saída ${nomeOrigem} + entrada ${lojaNome(sol.lojaId)}`);
  scheduleSave();
  renderEmergencia();
}

function atenderSolicitacaoEmergencia(solId) {
  const sol = getSolicitacoesEmergencia().find((s) => s.id === solId);
  if (!sol || (sol.status !== "enviada" && sol.status !== "pendente")) return;
  const isOwner = session.role === "loja" && session.lojaId === sol.lojaId;
  if (!canManageEmergencia() && !isOwner) {
    alert("Sem permissão para confirmar recebimento.");
    return;
  }
  if (sol.status === "pendente") {
    alert("Aguarde o Central enviar o pedido antes de confirmar o recebimento.");
    return;
  }
  if (!confirm("Confirmar recebimento na loja? Status: Atendida.")) return;
  sol.status = "atendida";
  sol.atendidaAt = new Date().toISOString();
  sol.atendidaPor = session.userId;
  pushHistoricoEmergencia(sol, "atendida", "Recebimento confirmado");
  scheduleSave();
  renderEmergencia();
}

function cancelarSolicitacaoEmergencia(solId) {
  const sol = getSolicitacoesEmergencia().find((s) => s.id === solId);
  if (!sol || sol.status !== "pendente") return;
  const isOwner = session.role === "loja" && session.lojaId === sol.lojaId;
  if (!canManageEmergencia() && !isOwner) return;
  if (!confirm("Cancelar esta solicitação pendente?")) return;
  sol.status = "cancelada";
  sol.canceladaAt = new Date().toISOString();
  pushHistoricoEmergencia(sol, "cancelada", "");
  scheduleSave();
  renderEmergencia();
}

function criarSolicitacaoEmergenciaFromForm() {
  if (!canCreateEmergencia()) {
    alert("Sem permissão para solicitar emergência.");
    return;
  }
  const lojaId = getEmergenciaLojaIdForCreate();
  if (!isLojaOperacional(lojaId)) {
    alert(emergenciaCreateNeedsLojaSelect() ? "Selecione a loja solicitante." : "Loja inválida para solicitação de emergência.");
    return;
  }
  const itens = emergenciaDraftItens
    .map((it) => ({ produtoId: it.produtoId, qtde: Math.max(0, Number(it.qtde) || 0) }))
    .filter((it) => it.produtoId && it.qtde > 0);
  if (!itens.length) {
    alert("Inclua ao menos um produto com quantidade.");
    return;
  }
  const dataDesejada = document.getElementById("emergencia-data")?.value || "";
  const observacao = (document.getElementById("emergencia-obs")?.value || "").trim();
  const onBehalf = emergenciaCreateNeedsLojaSelect();
  const sol = {
    id: uid(),
    lojaId,
    createdAt: new Date().toISOString(),
    createdBy: session.userId,
    dataDesejada,
    observacao,
    status: "pendente",
    itens,
    historico: [],
  };
  pushHistoricoEmergencia(
    sol,
    "pendente",
    onBehalf ? `Solicitação criada em nome de ${lojaNome(lojaId)}` : "Solicitação criada pela loja"
  );
  if (!state.solicitacoesEmergencia) state.solicitacoesEmergencia = [];
  state.solicitacoesEmergencia.unshift(sol);
  emergenciaDraftItens = [];
  const obs = document.getElementById("emergencia-obs");
  if (obs) obs.value = "";
  scheduleSave();
  renderEmergencia();
  alert(
    onBehalf
      ? `Solicitação de emergência criada para ${lojaNome(lojaId)}.`
      : "Solicitação de emergência enviada ao Central."
  );
}

function renderEmergenciaDraft() {
  const box = document.getElementById("emergencia-draft-itens");
  if (!box) return;
  if (!emergenciaDraftItens.length) {
    box.innerHTML = '<p class="empty-state">Nenhum item ainda. Busque e adicione produtos abaixo.</p>';
    return;
  }
  box.innerHTML = emergenciaDraftItens
    .map((it, idx) => {
      const p = getProduto(it.produtoId);
      return `<div class="emergencia-draft-row" data-idx="${idx}">
        <div>
          <strong>${esc(p?.nome || it.produtoId)}</strong>
          <div class="contagem-meta">${esc(p?.categoria || "")} · ${esc(p?.unidade || "")}</div>
        </div>
        <input class="qty-input" data-draft-qty type="number" min="0" step="any" value="${it.qtde}" aria-label="Quantidade" />
        <button class="btn btn-ghost btn-sm" data-draft-remove type="button">Remover</button>
      </div>`;
    })
    .join("");
  box.querySelectorAll(".emergencia-draft-row").forEach((row) => {
    const idx = Number(row.dataset.idx);
    row.querySelector("[data-draft-qty]")?.addEventListener("change", (ev) => {
      emergenciaDraftItens[idx].qtde = Math.max(0, Number(ev.target.value) || 0);
    });
    row.querySelector("[data-draft-remove]")?.addEventListener("click", () => {
      emergenciaDraftItens.splice(idx, 1);
      renderEmergenciaDraft();
    });
  });
}

function renderEmergenciaPrintSheet(sol) {
  const sheet = document.getElementById("emergencia-print-sheet");
  if (!sheet || !sol) return;
  const origemId = sol.origemLojaId || "central";
  const titulo = document.getElementById("emergencia-sheet-title");
  const meta = document.getElementById("emergencia-sheet-meta");
  const dateEl = document.getElementById("emergencia-sheet-date");
  if (titulo) titulo.textContent = `Emergência — ${lojaNome(origemId)} → ${lojaNome(sol.lojaId)}`;
  if (meta) {
    meta.textContent = `Status: ${EMERGENCIA_STATUS[sol.status] || sol.status} · Criado: ${formatDateTimeBR(sol.createdAt)}${
      sol.dataDesejada ? ` · Desejado: ${formatDateBR(sol.dataDesejada)}` : ""
    } · Origem: ${lojaNome(origemId)}`;
  }
  if (dateEl) dateEl.textContent = formatDateBR(hojeISO());
  const saldoTh = document.getElementById("emergencia-sheet-saldo-th");
  if (saldoTh) saldoTh.textContent = `Saldo ${lojaNome(origemId)}`;
  const tbody = document.querySelector("#table-emergencia-print tbody");
  if (tbody) {
    tbody.innerHTML = (sol.itens || [])
      .map((it) => {
        const p = getProduto(it.produtoId);
        const origemEst = ensureEstoque(origemId, it.produtoId);
        return `<tr>
          <td><strong>${esc(p?.nome || it.produtoId)}</strong></td>
          <td>${esc(p?.unidade || "")}</td>
          <td>${formatNum(it.qtde)}</td>
          <td>${formatNum(origemEst.saldo)}</td>
        </tr>`;
      })
      .join("");
  }
  const obsEl = document.getElementById("emergencia-sheet-obs");
  if (obsEl) obsEl.textContent = sol.observacao || "—";
}

function imprimirSolicitacaoEmergencia(solId) {
  const sol = getSolicitacoesEmergencia().find((s) => s.id === solId);
  if (!sol) return;
  renderEmergenciaPrintSheet(sol);
  const sheet = document.getElementById("emergencia-print-sheet");
  if (sheet) sheet.classList.remove("hidden");
  window.print();
  setTimeout(() => sheet?.classList.add("hidden"), 400);
}

function renderEmergencia() {
  const formWrap = document.getElementById("emergencia-form-wrap");
  const hint = document.getElementById("emergencia-hint");
  const lojaField = document.getElementById("emergencia-loja-field");
  const lojaSel = document.getElementById("emergencia-loja");
  const needsLojaSel = emergenciaCreateNeedsLojaSelect();
  if (formWrap) formWrap.classList.toggle("hidden", !canCreateEmergencia());
  if (lojaField) lojaField.classList.toggle("hidden", !canCreateEmergencia() || !needsLojaSel);
  if (lojaSel && canCreateEmergencia() && needsLojaSel) {
    const prev = lojaSel.value;
    const ops = getLojasOperacionaisEmergencia();
    lojaSel.innerHTML =
      `<option value="">Selecione a loja…</option>` +
      ops.map((l) => `<option value="${l.id}">${esc(l.nome)}</option>`).join("");
    if (prev && ops.some((l) => l.id === prev)) lojaSel.value = prev;
  }
  if (hint) {
    if (canCreateEmergencia() && needsLojaSel) {
      hint.textContent =
        "Crie uma solicitação em nome da loja. No envio, escolha a origem (Central ou outra loja): saída na origem e entrada no destino.";
    } else if (canCreateEmergencia()) {
      hint.textContent = "Peça itens urgentes ao Central a qualquer dia da semana (não só na sexta).";
    } else if (session.lojaId === "fabrica") {
      hint.textContent = "Fábrica não solicita emergência. Use Produção.";
    } else {
      hint.textContent = "Acompanhe solicitações de emergência das lojas.";
    }
  }

  if (canCreateEmergencia()) {
    const dataEl = document.getElementById("emergencia-data");
    if (dataEl && !dataEl.value) dataEl.value = hojeISO();
    renderEmergenciaDraft();
    const busca = document.getElementById("emergencia-busca-produto");
    const sug = document.getElementById("emergencia-sugestoes");
    if (busca && sug && !busca.dataset.bound) {
      busca.dataset.bound = "1";
      const renderSug = () => {
        const q = (busca.value || "").toLowerCase().trim();
        if (q.length < 2) {
          sug.innerHTML = "";
          sug.classList.add("hidden");
          return;
        }
        const lojaEmerg = getEmergenciaLojaIdForCreate() || session.lojaId || "central";
        const hits = produtosDaLoja(lojaEmerg)
          .filter((p) => p.nome.toLowerCase().includes(q) || p.categoria.toLowerCase().includes(q))
          .slice(0, 8);
        sug.classList.toggle("hidden", !hits.length);
        sug.innerHTML = hits
          .map(
            (p) =>
              `<button type="button" class="sugestao-item" data-add-pid="${p.id}">${esc(p.nome)} <span>${esc(p.unidade)}</span></button>`
          )
          .join("");
        sug.querySelectorAll("[data-add-pid]").forEach((btn) => {
          btn.addEventListener("click", () => {
            const pid = btn.dataset.addPid;
            const exist = emergenciaDraftItens.find((x) => x.produtoId === pid);
            if (exist) exist.qtde = Number(exist.qtde || 0) + 1;
            else emergenciaDraftItens.push({ produtoId: pid, qtde: 1 });
            busca.value = "";
            sug.innerHTML = "";
            sug.classList.add("hidden");
            renderEmergenciaDraft();
          });
        });
      };
      busca.addEventListener("input", renderSug);
    }
  }

  const filtro = document.getElementById("filter-emergencia-status")?.value || "abertas";
  let sols = [...getSolicitacoesEmergencia()];
  if (session.role === "loja" && !canManageEmergencia()) {
    sols = sols.filter((s) => s.lojaId === session.lojaId);
  }
  sols = sols.filter((s) => {
    if (filtro === "abertas") return s.status === "pendente" || s.status === "enviada";
    if (filtro === "pendente") return s.status === "pendente";
    if (filtro === "enviada") return s.status === "enviada";
    if (filtro === "atendida") return s.status === "atendida";
    if (filtro === "cancelada") return s.status === "cancelada";
    return true;
  });

  const list = document.getElementById("emergencia-lista");
  if (!list) return;
  if (!sols.length) {
    list.innerHTML = '<p class="empty-state">Nenhuma solicitação neste filtro.</p>';
    return;
  }

  list.innerHTML = sols
    .map((sol) => {
      const st = sol.status || "pendente";
      const isOwner = session.role === "loja" && session.lojaId === sol.lojaId;
      const origemPreview =
        st === "pendente" && canManageEmergencia() ? "central" : sol.origemLojaId || "central";
      const itensHtml = (sol.itens || [])
        .map((it) => {
          const p = getProduto(it.produtoId);
          let saldoHint = "";
          if (canManageEmergencia() && st === "pendente") {
            const saldoOrig = Number(ensureEstoque(origemPreview, it.produtoId).saldo || 0);
            saldoHint = ` · <span data-emerg-saldo-pid="${it.produtoId}">${esc(lojaNome(origemPreview))}: ${formatNum(saldoOrig)}</span>`;
          }
          return `<li><strong>${esc(p?.nome || it.produtoId)}</strong> — ${formatNum(it.qtde)} ${esc(p?.unidade || "")}${saldoHint}</li>`;
        })
        .join("");
      const hist = (sol.historico || [])
        .slice()
        .reverse()
        .slice(0, 4)
        .map(
          (h) =>
            `<div class="emergencia-hist-item">${esc(EMERGENCIA_STATUS[h.status] || h.status)} · ${formatDateTimeBR(h.at)}${h.nome ? ` · ${esc(h.nome)}` : ""}${h.nota ? ` · ${esc(h.nota)}` : ""}</div>`
        )
        .join("");
      const actions = [];
      let origemSelectHtml = "";
      if (canManageEmergencia() && st === "pendente") {
        const origens = getOrigensEmergencia();
        const opts = origens
          .map((l) => {
            const same = l.id === sol.lojaId ? " (destino)" : "";
            return `<option value="${l.id}"${l.id === "central" ? " selected" : ""}>${esc(l.nome)}${same}</option>`;
          })
          .join("");
        origemSelectHtml = `<label class="field emergencia-origem-field no-print">
          <span>Saindo de (origem)</span>
          <select data-emerg-origem="${sol.id}" aria-label="Origem do estoque">${opts}</select>
        </label>`;
        actions.push(`<button class="btn" data-emerg-enviar="${sol.id}" type="button">Enviar (baixa estoque)</button>`);
      }
      if ((canManageEmergencia() || isOwner) && st === "enviada") {
        actions.push(`<button class="btn" data-emerg-atender="${sol.id}" type="button">Confirmar recebimento</button>`);
      }
      if ((canManageEmergencia() || isOwner) && st === "pendente") {
        actions.push(`<button class="btn btn-ghost" data-emerg-cancelar="${sol.id}" type="button">Cancelar</button>`);
      }
      if (canManageEmergencia() || isOwner) {
        actions.push(`<button class="btn btn-ghost" data-emerg-print="${sol.id}" type="button">Imprimir</button>`);
      }
      const rotaHtml =
        sol.origemLojaId || st === "enviada" || st === "atendida"
          ? `<div class="contagem-meta emergencia-rota">${esc(lojaNome(sol.origemLojaId || "central"))} → ${esc(lojaNome(sol.lojaId))}</div>`
          : "";
      return `<article class="emergencia-card status-${st}" data-emerg-card="${sol.id}">
        <div class="emergencia-card-top">
          <div>
            <strong>${esc(lojaNome(sol.lojaId))}</strong>
            ${rotaHtml}
            <div class="contagem-meta">${formatDateTimeBR(sol.createdAt)}${sol.dataDesejada ? ` · p/ ${formatDateBR(sol.dataDesejada)}` : ""}</div>
          </div>
          <span class="badge badge-${st === "pendente" ? "falta" : st === "enviada" ? "baixo" : st === "atendida" ? "ok" : "falta"}">${esc(EMERGENCIA_STATUS[st] || st)}</span>
        </div>
        ${sol.observacao ? `<p class="emergencia-obs">${esc(sol.observacao)}</p>` : ""}
        <ul class="emergencia-itens">${itensHtml}</ul>
        ${origemSelectHtml}
        <div class="emergencia-hist">${hist || ""}</div>
        <div class="emergencia-actions no-print">${actions.join("")}</div>
      </article>`;
    })
    .join("");

  list.querySelectorAll("[data-emerg-origem]").forEach((sel) => {
    sel.addEventListener("change", () => {
      const solId = sel.dataset.emergOrigem;
      const origemId = sel.value || "central";
      const card = list.querySelector(`[data-emerg-card="${solId}"]`);
      const sol = getSolicitacoesEmergencia().find((s) => s.id === solId);
      if (!card || !sol) return;
      (sol.itens || []).forEach((it) => {
        const span = card.querySelector(`[data-emerg-saldo-pid="${it.produtoId}"]`);
        if (!span) return;
        const saldo = Number(ensureEstoque(origemId, it.produtoId).saldo || 0);
        span.textContent = `${lojaNome(origemId)}: ${formatNum(saldo)}`;
      });
    });
  });
  list.querySelectorAll("[data-emerg-enviar]").forEach((btn) => {
    btn.addEventListener("click", () => enviarSolicitacaoEmergencia(btn.dataset.emergEnviar));
  });
  list.querySelectorAll("[data-emerg-atender]").forEach((btn) => {
    btn.addEventListener("click", () => atenderSolicitacaoEmergencia(btn.dataset.emergAtender));
  });
  list.querySelectorAll("[data-emerg-cancelar]").forEach((btn) => {
    btn.addEventListener("click", () => cancelarSolicitacaoEmergencia(btn.dataset.emergCancelar));
  });
  list.querySelectorAll("[data-emerg-print]").forEach((btn) => {
    btn.addEventListener("click", () => imprimirSolicitacaoEmergencia(btn.dataset.emergPrint));
  });
}

function bindEmergenciaEvents() {
  document.getElementById("btn-emergencia-enviar")?.addEventListener("click", () => {
    criarSolicitacaoEmergenciaFromForm();
  });
  document.getElementById("filter-emergencia-status")?.addEventListener("change", () => {
    if (can("emergencia")) renderEmergencia();
  });
}

/* ── Render ── */
function render() {
  if (!session) return;
  const active = document.querySelector(".view.active")?.id?.replace("view-", "");
  if (active === "dashboard") renderDashboard();
  if (active === "contagem") renderContagem();
  if (active === "estoque") renderEstoque();
  if (active === "envio-sexta") renderEnvioSexta();
  if (active === "emergencia") renderEmergencia();
  if (active === "producao") renderProducao();
  if (active === "cotacao") renderCotacao();
  if (active === "resultado") renderResultado();
  if (active === "pedidos") renderPedidos();
  if (active === "valores") renderValores();
  if (active === "configuracoes") renderConfiguracoes();
  updateTableHScrollFooter();
}

/* ── Sticky viewport H-scroll for wide tables (desktop) ── */
const TABLE_HSCROLL_MQ = window.matchMedia("(min-width: 901px)");
let hscrollActiveWrap = null;
let hscrollSyncing = false;
let hscrollRaf = 0;
let hscrollWrapObserver = null;
let hscrollFooterBound = false;

function findActiveOverflowTableWrap() {
  const view = document.querySelector(".view.active");
  if (!view) return null;
  const wraps = [...view.querySelectorAll(".table-wrap")].filter((el) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.scrollWidth > el.clientWidth + 1;
  });
  if (!wraps.length) return null;
  // Prefer the wrap nearest the vertical center of the viewport; else the widest
  const mid = window.innerHeight / 2;
  let best = wraps[0];
  let bestScore = Infinity;
  for (const w of wraps) {
    const r = w.getBoundingClientRect();
    const dist = Math.abs(r.top + r.height / 2 - mid);
    if (dist < bestScore || (dist === bestScore && w.scrollWidth > best.scrollWidth)) {
      best = w;
      bestScore = dist;
    }
  }
  return best;
}

function hideTableHScrollFooter() {
  const footer = document.getElementById("table-hscroll-footer");
  if (hscrollActiveWrap) {
    hscrollActiveWrap.removeEventListener("scroll", onTableWrapScroll);
    hscrollActiveWrap.classList.remove("hscroll-synced");
    hscrollActiveWrap = null;
  }
  if (hscrollWrapObserver) {
    hscrollWrapObserver.disconnect();
    hscrollWrapObserver = null;
  }
  if (footer) {
    footer.hidden = true;
    footer.classList.remove("visible");
  }
  document.body.classList.remove("has-table-hscroll");
}

function onTableWrapScroll() {
  if (hscrollSyncing || !hscrollActiveWrap) return;
  const inner = document.getElementById("table-hscroll-footer-inner");
  if (!inner) return;
  hscrollSyncing = true;
  inner.scrollLeft = hscrollActiveWrap.scrollLeft;
  hscrollSyncing = false;
}

function onHScrollFooterScroll() {
  if (hscrollSyncing || !hscrollActiveWrap) return;
  const inner = document.getElementById("table-hscroll-footer-inner");
  if (!inner) return;
  hscrollSyncing = true;
  hscrollActiveWrap.scrollLeft = inner.scrollLeft;
  hscrollSyncing = false;
}

function bindHScrollActiveWrap(wrap) {
  if (hscrollActiveWrap === wrap) {
    wrap.classList.add("hscroll-synced");
    return;
  }
  if (hscrollActiveWrap) {
    hscrollActiveWrap.removeEventListener("scroll", onTableWrapScroll);
    hscrollActiveWrap.classList.remove("hscroll-synced");
  }
  hscrollActiveWrap = wrap;
  wrap.classList.add("hscroll-synced");
  wrap.addEventListener("scroll", onTableWrapScroll, { passive: true });
  if (hscrollWrapObserver) hscrollWrapObserver.disconnect();
  if (typeof ResizeObserver !== "undefined") {
    hscrollWrapObserver = new ResizeObserver(() => updateTableHScrollFooter());
    hscrollWrapObserver.observe(wrap);
    const table = wrap.querySelector("table");
    if (table) hscrollWrapObserver.observe(table);
  }
}

function updateTableHScrollFooter() {
  if (hscrollRaf) cancelAnimationFrame(hscrollRaf);
  hscrollRaf = requestAnimationFrame(() => {
    hscrollRaf = 0;
    const footer = document.getElementById("table-hscroll-footer");
    const inner = document.getElementById("table-hscroll-footer-inner");
    const spacer = document.getElementById("table-hscroll-spacer");
    if (!footer || !inner || !spacer) return;

    if (!TABLE_HSCROLL_MQ.matches || !session) {
      hideTableHScrollFooter();
      return;
    }

    const wrap = findActiveOverflowTableWrap();
    if (!wrap) {
      hideTableHScrollFooter();
      return;
    }

    bindHScrollActiveWrap(wrap);
    spacer.style.width = `${wrap.scrollWidth}px`;
    footer.hidden = false;
    footer.classList.add("visible");
    document.body.classList.add("has-table-hscroll");
    hscrollSyncing = true;
    inner.scrollLeft = wrap.scrollLeft;
    hscrollSyncing = false;
  });
}

function initTableHScrollFooter() {
  const inner = document.getElementById("table-hscroll-footer-inner");
  if (inner && !hscrollFooterBound) {
    inner.addEventListener("scroll", onHScrollFooterScroll, { passive: true });
    hscrollFooterBound = true;
  }
  updateTableHScrollFooter();
  window.addEventListener("resize", updateTableHScrollFooter, { passive: true });
  // On vertical scroll, switch which overflowing table owns the footer bar
  document.querySelector(".content")?.addEventListener("scroll", updateTableHScrollFooter, { passive: true });
  window.addEventListener("scroll", updateTableHScrollFooter, { passive: true });
  if (TABLE_HSCROLL_MQ.addEventListener) {
    TABLE_HSCROLL_MQ.addEventListener("change", updateTableHScrollFooter);
  } else if (TABLE_HSCROLL_MQ.addListener) {
    TABLE_HSCROLL_MQ.addListener(updateTableHScrollFooter);
  }
}

/* ── Init ── */
function initEvents() {
  document.getElementById("login-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const ok = tryLogin(
      document.getElementById("login-user").value,
      document.getElementById("login-pass").value
    );
    if (!ok) {
      document.getElementById("login-error").classList.remove("hidden");
      return;
    }
    document.getElementById("login-error").classList.add("hidden");
    enterApp();
  });

  document.getElementById("btn-logout").addEventListener("click", logout);
  document.getElementById("btn-config")?.addEventListener("click", () => switchView("configuracoes"));
  document.querySelectorAll("[data-config-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (session?.role !== "admin") return;
      switchConfigTab(btn.dataset.configTab);
    });
  });

  const bindAgendaSave = (el, evt = "change") => {
    el?.addEventListener(evt, () => {
      if (session?.role !== "admin") return;
      saveCotacaoAgendaFromForm();
    });
  };
  bindAgendaSave(document.getElementById("cot-agenda-auto"));
  bindAgendaSave(document.getElementById("cot-agenda-modo-manual"));
  bindAgendaSave(document.getElementById("cot-agenda-inicio-dia"));
  bindAgendaSave(document.getElementById("cot-agenda-fim-dia"));
  bindAgendaSave(document.getElementById("cot-agenda-inicio-hora"));
  bindAgendaSave(document.getElementById("cot-agenda-fim-hora"));

  document.getElementById("btn-cot-liberar-agora")?.addEventListener("click", () => {
    if (session?.role !== "admin") return;
    const a = ensureCotacaoAgenda();
    a.modo = "livre";
    state.cotacaoAgenda = normalizeCotacaoAgenda(a);
    scheduleSave();
    renderConfigCotacaoAgenda();
    if (document.getElementById("view-cotacao")?.classList.contains("active")) renderCotacao();
  });
  document.getElementById("btn-cot-travar-agora")?.addEventListener("click", () => {
    if (session?.role !== "admin") return;
    const a = ensureCotacaoAgenda();
    a.modo = "travada";
    state.cotacaoAgenda = normalizeCotacaoAgenda(a);
    scheduleSave();
    renderConfigCotacaoAgenda();
    if (document.getElementById("view-cotacao")?.classList.contains("active")) renderCotacao();
  });
  document.getElementById("btn-config-save-pass")?.addEventListener("click", () => {
    if (session?.role !== "fornecedor") return;
    const pass = (document.getElementById("config-new-pass")?.value || "").trim();
    const pass2 = (document.getElementById("config-new-pass2")?.value || "").trim();
    if (!pass || pass.length < 4) {
      alert("Senha deve ter ao menos 4 caracteres.");
      return;
    }
    if (pass !== pass2) {
      alert("As senhas não coincidem.");
      return;
    }
    const user = state.usuarios.find((u) => u.id === session.id && u.role === "fornecedor");
    if (!user) {
      alert("Usuário não encontrado.");
      return;
    }
    user.password = pass;
    scheduleSave();
    const el1 = document.getElementById("config-new-pass");
    const el2 = document.getElementById("config-new-pass2");
    if (el1) el1.value = "";
    if (el2) el2.value = "";
    alert("Senha atualizada.");
  });
  document.getElementById("btn-gerenciar-itens-cotacao")?.addEventListener("click", () => {
    if (session?.role !== "fornecedor") return;
    switchView("configuracoes");
    requestAnimationFrame(() => {
      document.getElementById("config-itens-cotacao-wrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.getElementById("filter-itens-cotacao-busca")?.addEventListener("input", () => {
    if (session?.role === "fornecedor") renderItensCotacaoFornecedor();
  });
  document.getElementById("btn-itens-marcar-todos")?.addEventListener("click", () => {
    if (session?.role !== "fornecedor") return;
    setTodosItensOcultosFornecedor(session.fornecedorId, false);
    scheduleSave();
    renderItensCotacaoFornecedor();
  });
  document.getElementById("btn-itens-desmarcar-todos")?.addEventListener("click", () => {
    if (session?.role !== "fornecedor") return;
    if (!confirm("Desmarcar todos? Esses produtos deixam de aparecer na sua Cotação.")) return;
    setTodosItensOcultosFornecedor(session.fornecedorId, true);
    scheduleSave();
    renderItensCotacaoFornecedor();
  });
  document.getElementById("menu-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("open");
  });

  ["filter-loja", "filter-categoria", "filter-estoque-busca", "filter-so-baixo", "filter-estoque-ocultos"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => can("estoque") && renderEstoque());
    el.addEventListener("change", () => can("estoque") && renderEstoque());
  });
  ["filter-contagem-busca", "filter-contagem-categoria", "filter-contagem-status", "filter-contagem-ocultos"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const refresh = () => {
      if (!can("contagem")) return;
      if (contagemPanel !== "lista") setContagemPanel("lista");
      renderContagemLista();
    };
    el.addEventListener("input", refresh);
    el.addEventListener("change", refresh);
  });
  document.getElementById("filter-so-produzir").addEventListener("change", () => can("producao") && renderProducao());
  ["filter-fornecedor", "filter-cot-categoria", "filter-cot-busca"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => can("cotacao") && renderCotacao());
    document.getElementById(id).addEventListener("change", () => can("cotacao") && renderCotacao());
  });
  document.getElementById("filter-res-busca")?.addEventListener("input", () => can("resultado") && renderResultado());
  document.getElementById("filter-res-fornecedor")?.addEventListener("change", () => can("resultado") && renderResultado());
  document.getElementById("filter-res-so-vencedor")?.addEventListener("change", () => can("resultado") && renderResultado());
  document.getElementById("btn-pedido-revisar")?.addEventListener("click", () => {
    if (!can("resultado")) return;
    const fid = document.getElementById("filter-res-fornecedor")?.value || "";
    abrirRevisaoPedido(fid || null);
  });
  document.getElementById("btn-pedido-compra")?.addEventListener("click", () => {
    if (!can("resultado")) return;
    emitirPedidoCompra("pdf");
  });
  document.getElementById("btn-pedido-compra-print")?.addEventListener("click", () => {
    if (!can("resultado")) return;
    emitirPedidoCompra("print");
  });
  ["filter-pedidos-status", "filter-pedidos-fornecedor"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => can("pedidos") && renderPedidos());
  });
  document.getElementById("btn-producao-pdf")?.addEventListener("click", () => {
    if (!can("producao")) return;
    exportarProducao("pdf");
  });
  document.getElementById("btn-producao-print")?.addEventListener("click", () => {
    if (!can("producao")) return;
    exportarProducao("print");
  });
  document.getElementById("btn-producao-concluir-lote")?.addEventListener("click", () => {
    if (!can("producao") || !canEditProducaoFabrica()) return;
    concluirProducaoItens(listItensProducaoParaConcluirLote());
  });
  ["filter-valores-loja", "filter-valores-busca", "filter-valores-so-saldo"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => can("valores") && renderValoresEstoque());
    el.addEventListener("change", () => can("valores") && renderValoresEstoque());
  });
  document.querySelectorAll("[data-valores-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!can("valores")) return;
      switchValoresTab(btn.dataset.valoresTab);
    });
  });
  document.getElementById("btn-snapshot-precos")?.addEventListener("click", () => {
    if (can("valores")) salvarSnapshotPrecosUI();
  });
  document.getElementById("btn-snapshot-precos-2")?.addEventListener("click", () => {
    if (can("valores")) salvarSnapshotPrecosUI();
  });
  document.getElementById("filter-inflacao-base")?.addEventListener("change", () => {
    if (can("valores")) renderInflacao();
  });
  document.getElementById("btn-estoque-add-produto")?.addEventListener("click", () => openProdutoModal(null));
  document.getElementById("filter-estoque-inativos")?.addEventListener("change", () => can("estoque") && renderEstoque());
  document.getElementById("btn-add-fornecedor")?.addEventListener("click", () => openFornecedorModal(null));

  document.getElementById("btn-reimport-seed")?.addEventListener("click", async () => {
    if (session?.role !== "admin") return;
    if (
      !confirm(
        "Isso substitui produtos, estoques, cotações e produção pelos dados atuais da planilha.\n\nSenhas e usuários são mantidos. Continuar?"
      )
    ) {
      return;
    }
    const ok = await reimportSeedFromPlanilha();
    const n = countSaldoPositivo(state?.estoques);
    alert(ok ? `Dados da planilha aplicados (${n} itens com saldo > 0).` : "Falha ao ler o seed. Abra a pasta do projeto (precisa de seed-data.js).");
  });

  document.getElementById("btn-baixar-itens-sem-preco")?.addEventListener("click", () => {
    downloadItensSemPrecoXls();
  });

  document.getElementById("btn-login-reseed")?.addEventListener("click", async () => {
    seedCache = null;
    const seed = await loadSeed();
    if (!seed?.produtos?.length) {
      alert(
        "Não achei os dados da planilha.\n\nAbra o arquivo index.html direto da pasta do projeto (precisa existir seed-data.js na mesma pasta).\nSe abriu só um HTML baixado, falha."
      );
      return;
    }
    if (!state) state = migrateState(defaultState(seed));
    state = applyOperationalFromSeed(state, seed);
    saveState();
    populateLoginUsers();
    const n = countSaldoPositivo(state.estoques);
    alert(`Dados da planilha carregados.\n${seed.produtos.length} produtos · ${n} itens com saldo > 0.\nEntre de novo para ver o estoque.`);
  });

  document.getElementById("btn-cloud-save")?.addEventListener("click", () => {
    if (session?.role !== "admin") return;
    connectCloudAndSync();
  });
  document.getElementById("btn-cloud-push")?.addEventListener("click", async () => {
    if (session?.role !== "admin") return;
    if (!initSupabase()) {
      alert("Configure a nuvem primeiro.");
      return;
    }
    const ok = await pushToCloud();
    alert(ok ? "Dados enviados para a nuvem." : "Falha ao enviar. Rode o supabase-setup.sql e confira as keys.");
    renderNuvem();
  });
  document.getElementById("btn-cloud-pull")?.addEventListener("click", async () => {
    if (session?.role !== "admin") return;
    if (!initSupabase()) {
      alert("Configure a nuvem primeiro.");
      return;
    }
    const remote = await pullFromCloud();
    if (!remote?.payload) {
      alert("Nuvem vazia ou inacessível.");
      return;
    }
    if (!confirm("Isso substitui os dados deste aparelho pelos da nuvem. Continuar?")) return;
    await applyRemoteState(remote.payload, remote.updated_at);
    subscribeCloud();
    renderNuvem();
    alert("Dados baixados da nuvem.");
  });

  ["modal-close", "modal-cancel"].forEach((id) => {
    document.getElementById(id).addEventListener("click", () => document.getElementById("modal").close());
  });

  bindEnvioEvents();
  bindEmergenciaEvents();
  bindContagemEvents();
  bindMobileBottomNav();
  bindFiltersCollapse();
  initTableHScrollFooter();
  window.addEventListener("resize", () => {
    if (can("estoque") && document.getElementById("view-estoque")?.classList.contains("active")) {
      renderEstoque();
    }
    updateMobileBottomNav();
  });
}

async function init() {
  state = await loadState();
  saveState(); // persiste migrações (ex.: senha admin)

  populateLoginUsers();
  initEvents();

  const hasCloud = initSupabase();
  if (hasCloud) {
    const remote = await pullFromCloud();
    if (remote?.payload && Object.keys(remote.payload).length > 1) {
      // Prefer cloud if it has real data and local is empty-ish product-wise conflict resolution by using newer
      const localTs = localStorage.getItem(STORAGE_KEY + ":ts");
      if (!localTs || (remote.updated_at && remote.updated_at > localTs)) {
        await applyRemoteState(remote.payload, remote.updated_at);
      }
    }
    subscribeCloud();
  }

  if (restoreSession()) enterApp();
}

document.addEventListener("DOMContentLoaded", init);
