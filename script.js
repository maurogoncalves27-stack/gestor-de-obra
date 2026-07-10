const STORAGE_KEY = "obra103-data-v2";
const TUTORIAL_KEY = "obra103-tutorial-done";

const TIPO_LABELS = {
  material_obra: "Materiais de obra",
  equipamento: "Equipamentos",
  utensilio: "Utensílios",
  contratacao: "Contratações",
  mao_de_obra: "Mão de obra",
};

const ITEM_STATUS_LABELS = {
  pendente: "Pendente",
  comprado: "Comprado",
  entregue: "Entregue",
};

const STATUS_LABELS = {
  pendente: "Pendente",
  bloqueada: "Bloqueada",
  em_andamento: "Em andamento",
  concluida: "Concluída",
  atrasada: "Atrasada",
};

const VIEW_TITLES = {
  dashboard: ["Dashboard", "Visão geral da obra"],
  etapas: ["Etapas", "Fases, prazos e orçamento"],
  itens: ["Itens & Compras", "Materiais, equipamentos e contratações"],
  dependencias: ["Dependências", "Pré-requisitos entre etapas e compras"],
  gastos: ["Gastos", "Lançamento de despesas"],
  cronograma: ["Cronograma", "Linha do tempo física"],
  relatorios: ["Relatórios", "Análises e gráficos"],
};

const TIPO_MIGRATE = {
  material: "material_obra",
  servico: "contratacao",
  outro: "material_obra",
};

let state = defaultState();
let charts = {};
let saveTimer = null;

function uid() {
  return crypto.randomUUID();
}

function defaultState() {
  const hoje = new Date().toISOString().slice(0, 10);
  return {
    projeto: {
      nome: "Obra 103",
      endereco: "",
      dataInicio: hoje,
      dataFimPrevisto: "",
      orcamentoGlobal: 0,
      responsavel: "",
      observacoes: "",
      geminiApiKey: "",
    },
    etapas: [],
    itens: [],
    gastos: [],
  };
}

const TUTORIAL_STEPS = [
  {
    icon: "🏗️",
    title: "Bem-vindo à Obra 103",
    html: `<p>Este sistema ajuda você a controlar <strong>cronograma</strong>, <strong>gastos</strong> e <strong>dependências</strong> da sua obra em um só lugar.</p>
      <p>Seus dados são salvos automaticamente. Exporte backup periodicamente pelo menu lateral.</p>
      <div class="tutorial-tip">💡 Siga os passos nesta ordem para montar sua obra corretamente.</div>`,
  },
  {
    icon: "⚙️",
    title: "1. Configure o projeto",
    html: `<p>Clique em <strong>Projeto</strong> no topo e preencha:</p>
      <ul class="tutorial-list">
        <li>Nome e endereço da obra</li>
        <li>Data de início e previsão de conclusão</li>
        <li>Orçamento global (opcional)</li>
        <li>Responsável técnico</li>
      </ul>
      <div class="tutorial-tip">Isso alimenta o prazo e os indicadores do Dashboard.</div>`,
    action: "projeto",
  },
  {
    icon: "📋",
    title: "2. Cadastre as etapas",
    html: `<p>Vá em <strong>Etapas</strong> e crie cada fase da obra (fundação, alvenaria, forro, acabamento…).</p>
      <ul class="tutorial-list">
        <li>Defina datas de início e fim previsto</li>
        <li>Informe o orçamento de cada etapa</li>
        <li>Atualize o % de conclusão conforme avança</li>
      </ul>`,
    action: "etapas",
  },
  {
    icon: "📦",
    title: "3. Cadastre itens e compras",
    html: `<p>Em <strong>Itens & Compras</strong>, liste tudo que precisa ser adquirido antes de executar etapas:</p>
      <ul class="tutorial-list">
        <li><strong>Materiais de obra</strong> — cimento, tijolos, gesso…</li>
        <li><strong>Equipamentos</strong> — betoneira, andaimes…</li>
        <li><strong>Utensílios</strong> — ferramentas</li>
        <li><strong>Contratações</strong> — pedreiro, eletricista… (com parcelamento e entrada)</li>
      </ul>
      <p>Marque como <em>comprado</em>, use parcelas com entrada ou vincule a um gasto.</p>`,
    action: "itens",
  },
  {
    icon: "🔗",
    title: "4. Defina dependências",
    html: `<p>Ao editar uma etapa, configure o que ela precisa para começar:</p>
      <ul class="tutorial-list">
        <li><strong>Etapas</strong> — ex.: forro de gesso só após alvenaria 100%</li>
        <li><strong>Itens</strong> — ex.: alvenaria só após comprar tijolos</li>
      </ul>
      <p>A aba <strong>Dependências</strong> mostra a cadeia visual e o que está bloqueado.</p>`,
    action: "dependencias",
  },
  {
    icon: "💰",
    title: "5. Lance os gastos",
    html: `<p>Em <strong>Gastos</strong>, registre cada despesa com NF, fornecedor, valor e categoria.</p>
      <ul class="tutorial-list">
        <li>Use <strong>📷 Escanear</strong> para fotografar NF/recibo — a IA preenche automaticamente</li>
        <li>Vincule à etapa correspondente</li>
        <li>Vincule ao item — ele será marcado como comprado automaticamente</li>
      </ul>`,
    action: "gastos",
  },
  {
    icon: "📊",
    title: "6. Acompanhe a obra",
    html: `<p>Use as ferramentas de acompanhamento:</p>
      <ul class="tutorial-list">
        <li><strong>Dashboard</strong> — resumo financeiro, alertas e bloqueios</li>
        <li><strong>Cronograma</strong> — linha do tempo com previsto × realizado</li>
        <li><strong>Relatórios</strong> — gráficos de gastos e curva físico-financeira</li>
      </ul>
      <div class="tutorial-tip">Exporte backup periodicamente pelo menu lateral.</div>`,
    action: "dashboard",
  },
];

function migrateState(data) {
  if (!data.itens) data.itens = [];
  if (!data.etapas) data.etapas = [];
  if (!data.projeto) data.projeto = defaultState().projeto;
  if (!data.projeto.geminiApiKey) data.projeto.geminiApiKey = "";

  data.etapas.forEach((e) => {
    if (!e.dependencias) e.dependencias = { etapas: [], itens: [] };
    if (!e.dependencias.etapas) e.dependencias.etapas = [];
    if (!e.dependencias.itens) e.dependencias.itens = [];
  });

  data.itens.forEach((it) => {
    if (!it.status) it.status = "pendente";
    if (!it.categoria) it.categoria = "material_obra";
    if (!it.parcelamento) it.parcelamento = { ativo: false, entrada: 0, qtdParcelas: 0, dataEntrada: "", intervaloDias: 30, parcelas: [] };
    if (it.categoria === "contratacao" && it.parcelamento.ativo && (!it.parcelamento.parcelas || !it.parcelamento.parcelas.length)) {
      it.parcelamento.parcelas = buildParcelas(it) || [];
    }
  });

  data.gastos?.forEach((g) => {
    if (TIPO_MIGRATE[g.tipo]) g.tipo = TIPO_MIGRATE[g.tipo];
    if (!g.itemId) g.itemId = "";
    if (!g.parcelaId) g.parcelaId = "";
    if (!g.comprovante) g.comprovante = "";
  });

  applyDataPatches(data);

  return data;
}

function applyDataPatches(data) {
  if (!data.meta) data.meta = {};
  let patchVersion = data.meta.patchVersion || 0;

  if (patchVersion < 1) {
    const exists = (data.itens || []).some(
      (i) =>
        (i.fornecedor || "").toLowerCase().includes("cortopassi") ||
        (i.nome || "").toLowerCase().includes("cortopassi")
    );

    if (!exists) {
      const itemId = uid();
      const entradaParcelaId = uid();
      const parcelaId = uid();
      const gastoId = uid();

      data.itens.push({
        id: itemId,
        nome: "Arquiteta Cortopassi",
        categoria: "contratacao",
        status: "entregue",
        valorPrevisto: 5400,
        fornecedor: "Cortopassi",
        etapaId: "",
        observacoes: "Contratação de projeto arquitetônico — serviço concluído. Entrada paga em 08/07/2026. Saldo de R$ 2.400,00 vence em 05/08/2026.",
        parcelamento: {
          ativo: true,
          entrada: 3000,
          qtdParcelas: 1,
          dataEntrada: "2026-07-08",
          intervaloDias: 28,
          parcelas: [
            {
              id: entradaParcelaId,
              tipo: "entrada",
              numero: 0,
              valor: 3000,
              vencimento: "2026-07-08",
              paga: true,
              gastoId,
            },
            {
              id: parcelaId,
              tipo: "parcela",
              numero: 1,
              valor: 2400,
              vencimento: "2026-08-05",
              paga: false,
              gastoId: "",
            },
          ],
        },
      });

      data.gastos.push({
        id: gastoId,
        data: "2026-07-08",
        valor: 3000,
        nf: "",
        fornecedor: "Cortopassi",
        descricao: "Arquiteta Cortopassi — Entrada",
        etapaId: "",
        tipo: "contratacao",
        itemId,
        parcelaId: entradaParcelaId,
        comprovante: "",
      });
    }

    patchVersion = 1;
  }

  if (patchVersion < 2) {
    const exists = (data.itens || []).some((i) => (i.nome || "").toLowerCase().includes("fritadeira"));

    if (!exists) {
      const itemId = uid();
      const gastoId = uid();

      data.itens.push({
        id: itemId,
        nome: "Fritadeira",
        categoria: "equipamento",
        status: "comprado",
        valorPrevisto: 6650,
        fornecedor: "",
        etapaId: "",
        observacoes: "",
        parcelamento: {
          ativo: false,
          entrada: 0,
          qtdParcelas: 0,
          dataEntrada: "",
          intervaloDias: 30,
          parcelas: [],
        },
      });

      data.gastos.push({
        id: gastoId,
        data: "2026-07-09",
        valor: 6650,
        nf: "",
        fornecedor: "",
        descricao: "Fritadeira",
        etapaId: "",
        tipo: "equipamento",
        itemId,
        parcelaId: "",
        comprovante: "",
      });
    }

    patchVersion = 2;
  }

  if (patchVersion < 3) {
    const exists = (data.itens || []).some(
      (i) =>
        (i.nome || "").toLowerCase().includes("monitor") &&
        i.categoria === "equipamento"
    );

    if (!exists) {
      const itemId = uid();
      const gastoId = uid();

      data.itens.push({
        id: itemId,
        nome: "Monitor de PC",
        categoria: "equipamento",
        status: "comprado",
        valorPrevisto: 1764,
        fornecedor: "",
        etapaId: "",
        observacoes: "",
        parcelamento: {
          ativo: false,
          entrada: 0,
          qtdParcelas: 0,
          dataEntrada: "",
          intervaloDias: 30,
          parcelas: [],
        },
      });

      data.gastos.push({
        id: gastoId,
        data: "2026-07-09",
        valor: 1764,
        nf: "",
        fornecedor: "",
        descricao: "Monitor de PC",
        etapaId: "",
        tipo: "equipamento",
        itemId,
        parcelaId: "",
        comprovante: "",
      });
    }

    patchVersion = 3;
  }

  if (patchVersion < 4) {
    const cortopassi = (data.itens || []).find(
      (i) =>
        (i.fornecedor || "").toLowerCase().includes("cortopassi") ||
        (i.nome || "").toLowerCase().includes("cortopassi")
    );
    if (cortopassi) {
      cortopassi.status = "entregue";
      if (!(cortopassi.observacoes || "").toLowerCase().includes("serviço concluído")) {
        cortopassi.observacoes = [
          cortopassi.observacoes,
          "Serviço concluído (saldo de R$ 2.400,00 permanece para 05/08/2026).",
        ]
          .filter(Boolean)
          .join(" ");
      }
    }
    patchVersion = 4;
  }

  data.meta.patchVersion = patchVersion;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrateState(JSON.parse(raw));
  } catch (_) {}
  return defaultState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  flashSave();
  if (window.ObraAuth?.isCloud()) {
    ObraAuth.scheduleCloudSave(state);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}

async function saveStateNow() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  flashSave();
  if (window.ObraAuth?.isCloud()) {
    try {
      await ObraAuth.saveNow(state);
    } catch (err) {
      console.error(err);
      alert("Erro ao salvar na nuvem. Dados mantidos neste aparelho.");
    }
  }
}

function flashSave() {
  const el = document.getElementById("save-indicator");
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 1500);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function parseDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatMoney(v) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDate(str) {
  if (!str) return "—";
  return parseDate(str).toLocaleDateString("pt-BR");
}

function formatPct(v) {
  return `${v.toFixed(1)}%`;
}

function getDeps(etapa) {
  return etapa.dependencias || { etapas: [], itens: [] };
}

function isItemOk(item) {
  if (!item) return false;
  if (item.status === "entregue") return true;
  if (item.categoria === "contratacao" && item.parcelamento?.ativo) {
    const parcelas = item.parcelamento.parcelas || [];
    return parcelas.length > 0 && parcelas.every((p) => p.paga);
  }
  return item.status === "comprado" || item.status === "entregue";
}

function buildParcelas(item) {
  if (item.categoria !== "contratacao" || !item.parcelamento?.ativo) return null;

  const total = Number(item.valorPrevisto) || 0;
  const entrada = Math.min(Number(item.parcelamento.entrada) || 0, total);
  const qtd = Math.max(0, Number(item.parcelamento.qtdParcelas) || 0);
  const dataEntrada = item.parcelamento.dataEntrada || new Date().toISOString().slice(0, 10);
  const intervalo = Math.max(1, Number(item.parcelamento.intervaloDias) || 30);
  const old = item.parcelamento.parcelas || [];
  const oldMap = Object.fromEntries(old.map((p) => [`${p.tipo}-${p.numero}`, p]));

  const parcelas = [];
  const oldEntrada = oldMap["entrada-0"];
  parcelas.push({
    id: oldEntrada?.id || uid(),
    tipo: "entrada",
    numero: 0,
    valor: entrada,
    vencimento: dataEntrada,
    paga: oldEntrada?.paga || false,
    gastoId: oldEntrada?.gastoId || "",
  });

  const saldo = Math.max(0, total - entrada);
  const valorBase = qtd > 0 ? Math.floor((saldo / qtd) * 100) / 100 : 0;
  let acumulado = entrada;

  for (let i = 1; i <= qtd; i++) {
    const val = i === qtd ? Math.round((total - acumulado) * 100) / 100 : valorBase;
    acumulado += val;
    const vencDate = addDays(parseDate(dataEntrada), intervalo * i);
    const oldP = oldMap[`parcela-${i}`];
    parcelas.push({
      id: oldP?.id || uid(),
      tipo: "parcela",
      numero: i,
      valor: val,
      vencimento: vencDate.toISOString().slice(0, 10),
      paga: oldP?.paga || false,
      gastoId: oldP?.gastoId || "",
    });
  }

  return parcelas;
}

function syncItemStatusFromParcelas(item) {
  if (!item.parcelamento?.ativo) return;
  const parcelas = item.parcelamento.parcelas || [];
  const pagas = parcelas.filter((p) => p.paga).length;
  if (pagas === parcelas.length && parcelas.length > 0) item.status = "entregue";
  else if (item.status === "entregue") return; // serviço concluído com saldo em aberto
  else if (pagas === 0) item.status = "pendente";
  else item.status = "comprado";
}

function getParcelamentoResumo(item) {
  if (item.categoria !== "contratacao" || !item.parcelamento?.ativo) return "—";
  const parcelas = item.parcelamento.parcelas || [];
  if (!parcelas.length) return "Configurar";
  const pagas = parcelas.filter((p) => p.paga).length;
  const prox = parcelas.find((p) => !p.paga);
  const proxTxt = prox
    ? `${prox.tipo === "entrada" ? "Entrada" : `${prox.numero}ª parcela`} ${formatMoney(prox.valor)}`
    : "Quitado";
  return `${pagas}/${parcelas.length} pagas · ${proxTxt}`;
}

function findParcela(itemId, parcelaId) {
  const item = state.itens.find((i) => i.id === itemId);
  if (!item?.parcelamento?.parcelas) return { item: null, parcela: null };
  const parcela = item.parcelamento.parcelas.find((p) => p.id === parcelaId);
  return { item, parcela };
}

function markParcelaPaga(item, parcela, gastoId) {
  parcela.paga = true;
  parcela.gastoId = gastoId;
  syncItemStatusFromParcelas(item);
}

function isEtapaOk(etapa) {
  return etapa && Number(etapa.percentualConclusao || 0) >= 100;
}

function getPendingDeps(etapa) {
  const deps = getDeps(etapa);
  const pendingEtapas = deps.etapas
    .map((id) => state.etapas.find((e) => e.id === id))
    .filter((e) => e && !isEtapaOk(e));
  const pendingItens = deps.itens
    .map((id) => state.itens.find((i) => i.id === id))
    .filter((i) => i && !isItemOk(i));
  return { etapas: pendingEtapas, itens: pendingItens };
}

function canStartEtapa(etapa) {
  const p = getPendingDeps(etapa);
  return p.etapas.length === 0 && p.itens.length === 0;
}

function getGastoEtapa(etapaId) {
  return state.gastos
    .filter((g) => g.etapaId === etapaId)
    .reduce((s, g) => s + Number(g.valor || 0), 0);
}

function getValorConsolidadoItem(item) {
  const fromGastos = state.gastos
    .filter((g) => g.itemId === item.id)
    .reduce((s, g) => s + Number(g.valor || 0), 0);
  if (fromGastos > 0) return fromGastos;

  if (item.parcelamento?.ativo) {
    return (item.parcelamento.parcelas || [])
      .filter((p) => p.paga)
      .reduce((s, p) => s + Number(p.valor || 0), 0);
  }

  if (item.status === "comprado" || item.status === "entregue") {
    return Number(item.valorPrevisto || 0);
  }

  return 0;
}

function getTotalOrcamento() {
  const somaEtapas = state.etapas.reduce((s, e) => s + Number(e.orcamentoPrevisto || 0), 0);
  const global = Number(state.projeto.orcamentoGlobal || 0);
  return global > 0 ? global : somaEtapas;
}

function getTotalGasto() {
  return state.gastos.reduce((s, g) => s + Number(g.valor || 0), 0);
}

function getAvancoFisico() {
  const total = getTotalOrcamento();
  if (total === 0) {
    const avg = state.etapas.reduce((s, e) => s + Number(e.percentualConclusao || 0), 0);
    return state.etapas.length ? avg / state.etapas.length : 0;
  }
  return state.etapas.reduce((s, e) => {
    const peso = Number(e.orcamentoPrevisto || 0) / total;
    return s + peso * Number(e.percentualConclusao || 0);
  }, 0);
}

function getExecucaoFinanceira() {
  const orc = getTotalOrcamento();
  if (orc === 0) return 0;
  return (getTotalGasto() / orc) * 100;
}

function computeStatus(etapa) {
  const pct = Number(etapa.percentualConclusao || 0);
  if (pct >= 100) return "concluida";

  if (!canStartEtapa(etapa) && pct === 0) return "bloqueada";

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const fimPrev = parseDate(etapa.dataFimPrevisto);

  if (fimPrev && hoje > fimPrev && pct < 100) return "atrasada";
  if (pct > 0 || (parseDate(etapa.dataInicio) && hoje >= parseDate(etapa.dataInicio))) {
    return "em_andamento";
  }
  return canStartEtapa(etapa) ? "pendente" : "bloqueada";
}

function getEtapaNome(id) {
  return state.etapas.find((e) => e.id === id)?.nome || "—";
}

function getItemNome(id) {
  return state.itens.find((i) => i.id === id)?.nome || "—";
}

function desvioClass(desvio, orcamento) {
  if (orcamento === 0) return "";
  const pct = (desvio / orcamento) * 100;
  if (pct <= 0) return "desvio-ok";
  if (pct <= 10) return "desvio-warn";
  return "desvio-bad";
}

function renderDepSummary(etapa) {
  const deps = getDeps(etapa);
  const total = deps.etapas.length + deps.itens.length;
  if (total === 0) return '<span class="dep-tag">Nenhuma</span>';
  const pending = getPendingDeps(etapa);
  const n = pending.etapas.length + pending.itens.length;
  if (n === 0) return `<span class="dep-tag ok">${total} OK</span>`;
  return `<span class="dep-tag pending">${n} pendente${n > 1 ? "s" : ""}</span>`;
}

function syncItemFromGasto(gasto) {
  if (!gasto.itemId) return;
  const item = state.itens.find((i) => i.id === gasto.itemId);
  if (!item) return;

  if (gasto.parcelaId && item.parcelamento?.ativo) {
    const parcela = item.parcelamento.parcelas.find((p) => p.id === gasto.parcelaId);
    if (parcela) markParcelaPaga(item, parcela, gasto.id);
    return;
  }

  if (item.status === "pendente") item.status = "comprado";
}

/* ── Navigation ── */
function openSidebar() {
  document.querySelector(".sidebar").classList.add("open");
  const backdrop = document.getElementById("sidebar-backdrop");
  backdrop.hidden = false;
  backdrop.classList.add("visible");
  document.body.classList.add("sidebar-open");
}

function closeSidebar() {
  document.querySelector(".sidebar").classList.remove("open");
  const backdrop = document.getElementById("sidebar-backdrop");
  backdrop.classList.remove("visible");
  backdrop.hidden = true;
  document.body.classList.remove("sidebar-open");
}

function initNav() {
  document.querySelectorAll(".nav-btn, .bottom-nav-btn[data-view]").forEach((btn) => {
    if (btn.dataset.view === "menu") return;
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.goto));
  });
  document.getElementById("menu-toggle").addEventListener("click", () => {
    const isOpen = document.querySelector(".sidebar").classList.contains("open");
    if (isOpen) closeSidebar();
    else openSidebar();
  });
  document.getElementById("bottom-nav-more")?.addEventListener("click", openSidebar);
  document.getElementById("sidebar-backdrop")?.addEventListener("click", closeSidebar);
}

function switchView(view) {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  document.querySelectorAll(".bottom-nav-btn").forEach((b) => {
    if (b.dataset.view === "menu") return;
    b.classList.toggle("active", b.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === `view-${view}`);
  });
  const [title, sub] = VIEW_TITLES[view] || ["", ""];
  document.getElementById("view-title").textContent = title;
  document.getElementById("view-subtitle").textContent = sub;
  closeSidebar();
  render();
  if (view === "relatorios") setTimeout(renderCharts, 50);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ── Dashboard ── */
function renderDashboard() {
  const orc = getTotalOrcamento();
  const gasto = getTotalGasto();
  const saldo = orc - gasto;

  document.getElementById("kpi-orcamento").textContent = formatMoney(orc);
  document.getElementById("kpi-gasto").textContent = formatMoney(gasto);
  const saldoEl = document.getElementById("kpi-saldo");
  saldoEl.textContent = formatMoney(saldo);
  saldoEl.className = `kpi-value ${saldo >= 0 ? "kpi-success" : "kpi-danger"}`;
  document.getElementById("kpi-avanco").textContent = formatPct(getAvancoFisico());
  document.getElementById("kpi-avanco-bar").style.width = `${Math.min(getAvancoFisico(), 100)}%`;
  document.getElementById("kpi-financeiro").textContent = formatPct(getExecucaoFinanceira());
  document.getElementById("kpi-financeiro-bar").style.width = `${Math.min(getExecucaoFinanceira(), 100)}%`;

  const ini = state.projeto.dataInicio;
  const fim = state.projeto.dataFimPrevisto;
  document.getElementById("kpi-prazo").textContent =
    ini && fim ? `${formatDate(ini)} → ${formatDate(fim)}` : "—";

  renderDashboardEtapas();
  renderDashboardAlertas();
  renderDashboardGastos();
}

function renderDashboardEtapas() {
  const el = document.getElementById("dashboard-etapas");
  const ativas = state.etapas
    .filter((e) => {
      const s = computeStatus(e);
      return s === "em_andamento" || s === "atrasada";
    })
    .slice(0, 5);

  if (!ativas.length) {
    el.innerHTML = '<p class="empty-state">Nenhuma etapa em andamento</p>';
    return;
  }

  el.innerHTML = ativas
    .map((e) => {
      const pct = Number(e.percentualConclusao || 0);
      return `<div class="etapa-mini">
        <div class="etapa-mini-info">
          <strong>${esc(e.nome)}</strong>
          <span>${formatDate(e.dataInicio)} — ${formatDate(e.dataFimPrevisto)}</span>
        </div>
        <div class="etapa-mini-bar"><div style="width:${pct}%"></div></div>
        <span>${pct}%</span>
      </div>`;
    })
    .join("");
}

function renderDashboardAlertas() {
  const el = document.getElementById("dashboard-alertas");
  const alerts = [];

  state.etapas.forEach((e) => {
    if (computeStatus(e) === "bloqueada") {
      const p = getPendingDeps(e);
      const parts = [];
      p.itens.forEach((i) => parts.push(`comprar <strong>${esc(i.nome)}</strong>`));
      p.etapas.forEach((x) => parts.push(`concluir <strong>${esc(x.nome)}</strong>`));
      alerts.push({
        type: "blocked",
        text: `<strong>${esc(e.nome)}</strong> bloqueada — aguarda: ${parts.join(", ")}`,
      });
    }
    const gasto = getGastoEtapa(e.id);
    const orc = Number(e.orcamentoPrevisto || 0);
    if (orc > 0 && gasto > orc) {
      alerts.push({
        type: "danger",
        text: `<strong>${esc(e.nome)}</strong> estourou o orçamento em ${formatMoney(gasto - orc)}`,
      });
    }
    if (computeStatus(e) === "atrasada") {
      alerts.push({
        type: "warn",
        text: `<strong>${esc(e.nome)}</strong> atrasada (${e.percentualConclusao}% concluída)`,
      });
    }
  });

  state.itens.filter((i) => i.status === "pendente").forEach((i) => {
    const etapa = state.etapas.find((e) => getDeps(e).itens.includes(i.id));
    if (etapa && computeStatus(etapa) === "bloqueada") {
      alerts.push({
        type: "info",
        text: `Comprar <strong>${esc(i.nome)}</strong> para liberar <strong>${esc(etapa.nome)}</strong>`,
      });
    }
  });

  const orc = getTotalOrcamento();
  const gasto = getTotalGasto();
  if (orc > 0 && gasto > orc) {
    alerts.push({
      type: "danger",
      text: `Orçamento global estourado em ${formatMoney(gasto - orc)}`,
    });
  }

  const hojeStr = new Date().toISOString().slice(0, 10);
  state.itens.forEach((item) => {
    if (!item.parcelamento?.ativo) return;
    (item.parcelamento.parcelas || []).forEach((p) => {
      if (!p.paga && p.vencimento && p.vencimento < hojeStr) {
        const label = p.tipo === "entrada" ? "Entrada" : `${p.numero}ª parcela`;
        alerts.push({
          type: "warn",
          text: `<strong>${esc(item.nome)}</strong> — ${label} vencida (${formatDate(p.vencimento)})`,
        });
      }
    });
  });

  if (!alerts.length) {
    el.innerHTML = '<p class="empty-state">✅ Nenhum alerta no momento</p>';
    return;
  }

  el.innerHTML = alerts
    .map((a) => `<div class="alert-item alert-${a.type}">⚠ ${a.text}</div>`)
    .join("");
}

function renderDashboardGastos() {
  const el = document.getElementById("dashboard-gastos");
  const recentes = [...state.gastos]
    .sort((a, b) => (b.data || "").localeCompare(a.data || ""))
    .slice(0, 5);

  if (!recentes.length) {
    el.innerHTML = '<p class="empty-state">Nenhum gasto lançado</p>';
    return;
  }

  el.innerHTML = `<table class="data-table data-table-compact">
    <thead><tr><th>Data</th><th>Fornecedor</th><th>Etapa</th><th>Valor</th></tr></thead>
    <tbody>${recentes
      .map(
        (g) => `<tr>
        <td data-label="Data">${formatDate(g.data)}</td>
        <td data-label="Fornecedor">${esc(g.fornecedor || "—")}</td>
        <td data-label="Etapa">${esc(getEtapaNome(g.etapaId))}</td>
        <td data-label="Valor">${formatMoney(Number(g.valor))}</td>
      </tr>`
      )
      .join("")}</tbody></table>`;
}

/* ── Etapas ── */
function renderEtapas() {
  const tbody = document.querySelector("#table-etapas tbody");
  let totalOrc = 0, totalGasto = 0, totalAvanco = 0;

  tbody.innerHTML = state.etapas.length
    ? state.etapas
    .sort((a, b) => a.ordem - b.ordem)
    .map((e) => {
      const gasto = getGastoEtapa(e.id);
      const orc = Number(e.orcamentoPrevisto || 0);
      const desvio = gasto - orc;
      const status = computeStatus(e);
      totalOrc += orc;
      totalGasto += gasto;
      totalAvanco += Number(e.percentualConclusao || 0);

      return `<tr>
        <td data-label="#">${e.ordem}</td>
        <td data-label="Etapa"><strong>${esc(e.nome)}</strong></td>
        <td data-label="Início">${formatDate(e.dataInicio)}</td>
        <td data-label="Fim previsto">${formatDate(e.dataFimPrevisto)}</td>
        <td data-label="Fim real">${formatDate(e.dataFimReal)}</td>
        <td data-label="Orçamento">${formatMoney(orc)}</td>
        <td data-label="Gasto">${formatMoney(gasto)}</td>
        <td data-label="Desvio" class="${desvioClass(desvio, orc)}">${desvio >= 0 ? "+" : ""}${formatMoney(desvio)}</td>
        <td data-label="% físico">${e.percentualConclusao}%</td>
        <td data-label="Dependências">${renderDepSummary(e)}</td>
        <td data-label="Status"><span class="badge badge-${status}">${STATUS_LABELS[status]}</span></td>
        <td class="td-actions" data-label="">
          <button class="btn btn-ghost btn-sm" data-edit-etapa="${e.id}" type="button">Editar</button>
          <button class="btn-danger" data-del-etapa="${e.id}" type="button">Excluir</button>
        </td>
      </tr>`;
    })
    .join("")
    : '<tr><td colspan="12" class="empty-state" data-label="">Nenhuma etapa cadastrada. Clique em <strong>+ Nova etapa</strong> ou siga o tutorial.</td></tr>';

  document.getElementById("etapas-total-orcamento").textContent = formatMoney(totalOrc);
  document.getElementById("etapas-total-gasto").textContent = formatMoney(totalGasto);
  const desvioTotal = totalGasto - totalOrc;
  const desvioEl = document.getElementById("etapas-total-desvio");
  desvioEl.textContent = `${desvioTotal >= 0 ? "+" : ""}${formatMoney(desvioTotal)}`;
  desvioEl.className = desvioClass(desvioTotal, totalOrc);
  document.getElementById("etapas-total-avanco").textContent = state.etapas.length
    ? formatPct(totalAvanco / state.etapas.length)
    : "—";

  tbody.querySelectorAll("[data-edit-etapa]").forEach((btn) => {
    btn.addEventListener("click", () => openEtapaModal(btn.dataset.editEtapa));
  });
  tbody.querySelectorAll("[data-del-etapa]").forEach((btn) => {
    btn.addEventListener("click", () => deleteEtapa(btn.dataset.delEtapa));
  });
}

function buildDepCheckboxes(type, selectedIds, excludeEtapaId) {
  const list =
    type === "etapa"
      ? state.etapas.filter((e) => e.id !== excludeEtapaId)
      : state.itens;

  if (!list.length) {
    return `<p class="field-hint">Nenhum ${type === "etapa" ? "etapa" : "item"} disponível.</p>`;
  }

  return `<div class="check-list">${list
    .map((x) => {
      const label = type === "etapa" ? x.nome : `${x.nome} (${TIPO_LABELS[x.categoria] || x.categoria})`;
      const checked = selectedIds.includes(x.id) ? "checked" : "";
      return `<label class="check-item">
        <input type="checkbox" name="dep-${type}" value="${x.id}" ${checked} />
        ${esc(label)}
      </label>`;
    })
    .join("")}</div>`;
}

function openEtapaModal(id) {
  const etapa = id ? state.etapas.find((e) => e.id === id) : null;
  const isNew = !etapa;
  const deps = etapa ? getDeps(etapa) : { etapas: [], itens: [] };

  document.getElementById("modal-title").textContent = isNew ? "Nova etapa" : "Editar etapa";
  document.getElementById("modal-body").innerHTML = `
    <label class="field"><span>Nome da etapa</span>
      <input id="f-nome" required type="text" value="${escAttr(etapa?.nome || "")}" /></label>
    <div class="field-row">
      <label class="field"><span>Data início</span>
        <input id="f-inicio" type="date" value="${etapa?.dataInicio || ""}" /></label>
      <label class="field"><span>Fim previsto</span>
        <input id="f-fim-prev" type="date" value="${etapa?.dataFimPrevisto || ""}" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Fim real</span>
        <input id="f-fim-real" type="date" value="${etapa?.dataFimReal || ""}" /></label>
      <label class="field"><span>% conclusão física</span>
        <input id="f-pct" max="100" min="0" type="number" value="${etapa?.percentualConclusao ?? 0}" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Orçamento previsto (R$)</span>
        <input id="f-orc" min="0" step="0.01" type="number" value="${etapa?.orcamentoPrevisto ?? 0}" /></label>
      <label class="field"><span>Responsável</span>
        <input id="f-resp" type="text" value="${escAttr(etapa?.responsavel || "")}" /></label>
    </div>
    <div class="field">
      <span>Depende de etapas concluídas (100%)</span>
      ${buildDepCheckboxes("etapa", deps.etapas, etapa?.id)}
      <p class="field-hint">Ex.: forro de gesso depende da alvenaria estar concluída.</p>
    </div>
    <div class="field">
      <span>Depende de itens comprados/entregues</span>
      ${buildDepCheckboxes("item", deps.itens, null)}
      <p class="field-hint">Ex.: alvenaria depende da compra de tijolos e cimento.</p>
    </div>`;

  const modal = document.getElementById("modal");
  modal.showModal();

  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    const depEtapas = [...document.querySelectorAll('input[name="dep-etapa"]:checked')].map((c) => c.value);
    const depItens = [...document.querySelectorAll('input[name="dep-item"]:checked')].map((c) => c.value);

    const data = {
      nome: document.getElementById("f-nome").value.trim(),
      dataInicio: document.getElementById("f-inicio").value,
      dataFimPrevisto: document.getElementById("f-fim-prev").value,
      dataFimReal: document.getElementById("f-fim-real").value,
      percentualConclusao: Math.min(100, Math.max(0, Number(document.getElementById("f-pct").value))),
      orcamentoPrevisto: Number(document.getElementById("f-orc").value) || 0,
      responsavel: document.getElementById("f-resp").value.trim(),
      dependencias: { etapas: depEtapas, itens: depItens },
    };

    if (!data.nome) return;

    if (isNew) {
      const maxOrdem = state.etapas.reduce((m, e) => Math.max(m, e.ordem), 0);
      state.etapas.push({ id: uid(), ordem: maxOrdem + 1, status: "pendente", ...data });
    } else {
      Object.assign(etapa, data);
    }

    modal.close();
    scheduleSave();
    render();
  };
}

function deleteEtapa(id) {
  if (!confirm("Excluir esta etapa? Dependências vinculadas serão removidas.")) return;
  state.etapas = state.etapas.filter((e) => e.id !== id);
  state.etapas.forEach((e) => {
    getDeps(e).etapas = getDeps(e).etapas.filter((x) => x !== id);
  });
  state.gastos.forEach((g) => { if (g.etapaId === id) g.etapaId = ""; });
  state.itens.forEach((i) => { if (i.etapaId === id) i.etapaId = ""; });
  state.etapas.forEach((e, i) => (e.ordem = i + 1));
  scheduleSave();
  render();
}

/* ── Itens ── */
function renderItens() {
  const tbody = document.querySelector("#table-itens tbody");
  let totalPrev = 0;
  let totalCons = 0;

  tbody.innerHTML = state.itens
    .map((i) => {
      const parcelado = i.categoria === "contratacao" && i.parcelamento?.ativo;
      const previsto = Number(i.valorPrevisto || 0);
      const consolidado = getValorConsolidadoItem(i);
      const desvio = consolidado - previsto;
      totalPrev += previsto;
      totalCons += consolidado;

      return `<tr>
      <td data-label="Item"><strong>${esc(i.nome)}</strong></td>
      <td data-label="Categoria"><span class="badge badge-${i.categoria}">${TIPO_LABELS[i.categoria] || i.categoria}</span></td>
      <td data-label="Etapa">${esc(getEtapaNome(i.etapaId))}</td>
      <td data-label="Previsto">${formatMoney(previsto)}</td>
      <td data-label="Consolidado">${formatMoney(consolidado)}</td>
      <td data-label="Desvio" class="${desvioClass(desvio, previsto)}">${desvio >= 0 ? "+" : ""}${formatMoney(desvio)}</td>
      <td data-label="Pagamento">${parcelado ? `<span class="parcela-pendente">${esc(getParcelamentoResumo(i))}</span>` : "—"}</td>
      <td data-label="Status"><span class="badge badge-${i.status}">${ITEM_STATUS_LABELS[i.status]}</span></td>
      <td data-label="Fornecedor">${esc(i.fornecedor || "—")}</td>
      <td class="td-actions" data-label="">
        <button class="btn btn-ghost btn-sm" data-edit-item="${i.id}" type="button">Editar</button>
        ${parcelado ? `<button class="btn btn-ghost btn-sm" data-parcelas-item="${i.id}" type="button">Parcelas</button>` : ""}
        ${!parcelado && i.status === "pendente" ? `<button class="btn btn-ghost btn-sm" data-comprar-item="${i.id}" type="button">Marcar comprado</button>` : ""}
        <button class="btn-danger" data-del-item="${i.id}" type="button">Excluir</button>
      </td>
    </tr>`;
    })
    .join("") || '<tr><td colspan="10" class="empty-state">Nenhum item cadastrado</td></tr>';

  document.getElementById("itens-total-previsto").textContent = formatMoney(totalPrev);
  document.getElementById("itens-total-consolidado").textContent = formatMoney(totalCons);
  const desvioTotal = totalCons - totalPrev;
  const desvioEl = document.getElementById("itens-total-desvio");
  desvioEl.textContent = `${desvioTotal >= 0 ? "+" : ""}${formatMoney(desvioTotal)}`;
  desvioEl.className = desvioClass(desvioTotal, totalPrev);

  const compras = state.itens.filter((i) => i.categoria !== "contratacao");
  const contratos = state.itens.filter((i) => i.categoria === "contratacao");
  const sumPrev = (list) => list.reduce((s, i) => s + Number(i.valorPrevisto || 0), 0);
  const sumCons = (list) => list.reduce((s, i) => s + getValorConsolidadoItem(i), 0);

  document.getElementById("itens-resumo").innerHTML = `
    <div class="itens-resumo-card"><span>Previsto total</span><strong>${formatMoney(totalPrev)}</strong></div>
    <div class="itens-resumo-card"><span>Consolidado total</span><strong>${formatMoney(totalCons)}</strong></div>
    <div class="itens-resumo-card"><span>Compras (prev. / cons.)</span><strong>${formatMoney(sumPrev(compras))} / ${formatMoney(sumCons(compras))}</strong></div>
    <div class="itens-resumo-card"><span>Contratações (prev. / cons.)</span><strong>${formatMoney(sumPrev(contratos))} / ${formatMoney(sumCons(contratos))}</strong></div>`;

  tbody.querySelectorAll("[data-edit-item]").forEach((btn) => {
    btn.addEventListener("click", () => openItemModal(btn.dataset.editItem));
  });
  tbody.querySelectorAll("[data-parcelas-item]").forEach((btn) => {
    btn.addEventListener("click", () => openParcelasModal(btn.dataset.parcelasItem));
  });
  tbody.querySelectorAll("[data-comprar-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = state.itens.find((i) => i.id === btn.dataset.comprarItem);
      if (item) { item.status = "comprado"; scheduleSave(); render(); }
    });
  });
  tbody.querySelectorAll("[data-del-item]").forEach((btn) => {
    btn.addEventListener("click", () => deleteItem(btn.dataset.delItem));
  });
}

function toggleParcelamentoUI() {
  const cat = document.getElementById("i-cat")?.value;
  const block = document.getElementById("parcelamento-block");
  if (!block) return;
  block.classList.toggle("hidden", cat !== "contratacao");
  if (cat === "contratacao") renderParcelasPreview();
}

function renderParcelasPreview() {
  const preview = document.getElementById("parcelas-preview");
  if (!preview) return;

  const total = Number(document.getElementById("i-valor")?.value) || 0;
  const ativo = document.getElementById("i-parcelado")?.checked;
  if (!ativo || total <= 0) {
    preview.innerHTML = "";
    return;
  }

  const temp = {
    categoria: "contratacao",
    valorPrevisto: total,
    parcelamento: {
      ativo: true,
      entrada: Number(document.getElementById("i-entrada")?.value) || 0,
      qtdParcelas: Number(document.getElementById("i-qtd-parcelas")?.value) || 0,
      dataEntrada: document.getElementById("i-data-entrada")?.value || new Date().toISOString().slice(0, 10),
      intervaloDias: Number(document.getElementById("i-intervalo")?.value) || 30,
      parcelas: [],
    },
  };

  const parcelas = buildParcelas(temp) || [];
  if (!parcelas.length) {
    preview.innerHTML = '<p class="field-hint">Informe entrada e parcelas para visualizar o cronograma.</p>';
    return;
  }

  preview.innerHTML = `<table class="parcelas-table">
    <thead><tr><th></th><th>Valor</th><th>Vencimento</th></tr></thead>
    <tbody>${parcelas
      .map(
        (p) => `<tr>
        <td>${p.tipo === "entrada" ? "Entrada" : `${p.numero}ª parcela`}</td>
        <td>${formatMoney(p.valor)}</td>
        <td>${formatDate(p.vencimento)}</td>
      </tr>`
      )
      .join("")}</tbody></table>`;
}

function openItemModal(id) {
  const item = id ? state.itens.find((i) => i.id === id) : null;
  const isNew = !item;
  const parc = item?.parcelamento || {
    ativo: false,
    entrada: 0,
    qtdParcelas: 1,
    dataEntrada: new Date().toISOString().slice(0, 10),
    intervaloDias: 30,
    parcelas: [],
  };

  document.getElementById("modal-title").textContent = isNew ? "Novo item" : "Editar item";
  document.getElementById("modal-body").innerHTML = `
    <label class="field"><span>Nome do item</span>
      <input id="i-nome" required type="text" value="${escAttr(item?.nome || "")}" /></label>
    <div class="field-row">
      <label class="field"><span>Categoria</span>
        <select id="i-cat">
          ${Object.entries(TIPO_LABELS)
            .map(([k, v]) => `<option value="${k}" ${item?.categoria === k ? "selected" : ""}>${v}</option>`)
            .join("")}
        </select></label>
      <label class="field"><span>Status</span>
        <select id="i-status">
          ${Object.entries(ITEM_STATUS_LABELS)
            .map(([k, v]) => `<option value="${k}" ${item?.status === k ? "selected" : ""}>${v}</option>`)
            .join("")}
        </select></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Valor previsto / orçado (R$)</span>
        <input id="i-valor" min="0" step="0.01" type="number" value="${item?.valorPrevisto ?? 0}" /></label>
      <label class="field"><span>Valor consolidado (gastos pagos)</span>
        <input disabled type="text" value="${item ? formatMoney(getValorConsolidadoItem(item)) : formatMoney(0)}" /></label>
    </div>
    <p class="field-hint">O consolidado é a soma dos gastos vinculados a este item (ou parcelas pagas).</p>
    <label class="field"><span>Fornecedor / contratado</span>
      <input id="i-forn" type="text" value="${escAttr(item?.fornecedor || "")}" /></label>
    <div class="parcelamento-block ${item?.categoria === "contratacao" ? "" : "hidden"}" id="parcelamento-block">
      <label class="check-inline">
        <input id="i-parcelado" type="checkbox" ${parc.ativo ? "checked" : ""} />
        Parcelar com entrada
      </label>
      <div class="field-row" style="margin-top:0.75rem">
        <label class="field"><span>Entrada (R$)</span>
          <input id="i-entrada" min="0" step="0.01" type="number" value="${parc.entrada ?? 0}" /></label>
        <label class="field"><span>Nº de parcelas</span>
          <input id="i-qtd-parcelas" min="0" step="1" type="number" value="${parc.qtdParcelas ?? 1}" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Data da entrada</span>
          <input id="i-data-entrada" type="date" value="${parc.dataEntrada || new Date().toISOString().slice(0, 10)}" /></label>
        <label class="field"><span>Intervalo entre parcelas (dias)</span>
          <input id="i-intervalo" min="1" step="1" type="number" value="${parc.intervaloDias ?? 30}" /></label>
      </div>
      <p class="field-hint">O saldo (total − entrada) será dividido igualmente nas parcelas.</p>
      <div id="parcelas-preview"></div>
    </div>
    <label class="field"><span>Etapa vinculada (opcional)</span>
      <select id="i-etapa">
        <option value="">Nenhuma</option>
        ${state.etapas.map((e) => `<option value="${e.id}" ${item?.etapaId === e.id ? "selected" : ""}>${esc(e.nome)}</option>`).join("")}
      </select></label>
    <label class="field"><span>Observações</span>
      <textarea id="i-obs" rows="2">${esc(item?.observacoes || "")}</textarea></label>`;

  const modal = document.getElementById("modal");
  modal.showModal();

  document.getElementById("i-cat").addEventListener("change", toggleParcelamentoUI);
  ["i-valor", "i-entrada", "i-qtd-parcelas", "i-data-entrada", "i-intervalo"].forEach((fid) => {
    document.getElementById(fid)?.addEventListener("input", renderParcelasPreview);
  });
  document.getElementById("i-parcelado")?.addEventListener("change", renderParcelasPreview);
  toggleParcelamentoUI();

  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    const categoria = document.getElementById("i-cat").value;
    const parcelado = categoria === "contratacao" && document.getElementById("i-parcelado").checked;

    const data = {
      nome: document.getElementById("i-nome").value.trim(),
      categoria,
      status: document.getElementById("i-status").value,
      valorPrevisto: Number(document.getElementById("i-valor").value) || 0,
      fornecedor: document.getElementById("i-forn").value.trim(),
      etapaId: document.getElementById("i-etapa").value,
      observacoes: document.getElementById("i-obs").value.trim(),
      parcelamento: {
        ativo: parcelado,
        entrada: Number(document.getElementById("i-entrada").value) || 0,
        qtdParcelas: Number(document.getElementById("i-qtd-parcelas").value) || 0,
        dataEntrada: document.getElementById("i-data-entrada").value,
        intervaloDias: Number(document.getElementById("i-intervalo").value) || 30,
        parcelas: item?.parcelamento?.parcelas || [],
      },
    };
    if (!data.nome) return;

    let target;
    if (isNew) {
      target = { id: uid(), ...data };
      state.itens.push(target);
    } else {
      Object.assign(item, data);
      target = item;
    }

    if (parcelado) {
      target.parcelamento.parcelas = buildParcelas(target) || [];
      syncItemStatusFromParcelas(target);
    } else {
      target.parcelamento = { ativo: false, entrada: 0, qtdParcelas: 0, dataEntrada: "", intervaloDias: 30, parcelas: [] };
    }

    modal.close();
    scheduleSave();
    render();
  };
}

function openParcelasModal(itemId) {
  const item = state.itens.find((i) => i.id === itemId);
  if (!item?.parcelamento?.ativo) return;

  const hojeStr = new Date().toISOString().slice(0, 10);
  const parcelas = item.parcelamento.parcelas || [];

  document.getElementById("modal-title").textContent = `Parcelas — ${item.nome}`;
  const consolidado = getValorConsolidadoItem(item);
  const previsto = Number(item.valorPrevisto || 0);
  document.getElementById("modal-body").innerHTML = `
    <p class="field-hint">
      <strong>Previsto:</strong> ${formatMoney(previsto)} ·
      <strong>Consolidado:</strong> ${formatMoney(consolidado)} ·
      Entrada ${formatMoney(item.parcelamento.entrada)} + ${item.parcelamento.qtdParcelas} parcela(s)
    </p>
    <table class="parcelas-table">
      <thead><tr><th>Pagamento</th><th>Valor</th><th>Vencimento</th><th>Status</th><th></th></tr></thead>
      <tbody>${parcelas
        .map((p) => {
          const label = p.tipo === "entrada" ? "Entrada" : `${p.numero}ª parcela`;
          let statusCls = "parcela-pendente";
          let statusTxt = "Pendente";
          if (p.paga) {
            statusCls = "parcela-paga";
            statusTxt = "Paga";
          } else if (p.vencimento && p.vencimento < hojeStr) {
            statusCls = "parcela-atraso";
            statusTxt = "Vencida";
          }
          return `<tr>
            <td>${label}</td>
            <td>${formatMoney(p.valor)}</td>
            <td>${formatDate(p.vencimento)}</td>
            <td class="${statusCls}">${statusTxt}</td>
            <td>${p.paga ? "" : `<button class="btn btn-sm" data-pagar-parcela="${p.id}" type="button">Registrar pagamento</button>`}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;

  const modal = document.getElementById("modal");
  modal.showModal();

  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    modal.close();
  };

  document.querySelectorAll("[data-pagar-parcela]").forEach((btn) => {
    btn.addEventListener("click", () => {
      modal.close();
      openGastoFromParcela(itemId, btn.dataset.pagarParcela);
    });
  });
}

function openGastoFromParcela(itemId, parcelaId) {
  const { item, parcela } = findParcela(itemId, parcelaId);
  if (!item || !parcela) return;
  const label = parcela.tipo === "entrada" ? "Entrada" : `Parcela ${parcela.numero}`;
  openGastoModal(null, {
    itemId: item.id,
    parcelaId: parcela.id,
    etapaId: item.etapaId || "",
    tipo: "contratacao",
    valor: parcela.valor,
    data: parcela.vencimento || new Date().toISOString().slice(0, 10),
    fornecedor: item.fornecedor || "",
    descricao: `${item.nome} — ${label}`,
  });
}

function deleteItem(id) {
  if (!confirm("Excluir este item?")) return;
  state.itens = state.itens.filter((i) => i.id !== id);
  state.etapas.forEach((e) => {
    getDeps(e).itens = getDeps(e).itens.filter((x) => x !== id);
  });
  state.gastos.forEach((g) => { if (g.itemId === id) g.itemId = ""; });
  scheduleSave();
  render();
}

/* ── Dependências ── */
function renderDependencias() {
  const el = document.getElementById("dep-cards");
  const etapasComDeps = state.etapas
    .filter((e) => getDeps(e).etapas.length > 0 || getDeps(e).itens.length > 0)
    .sort((a, b) => a.ordem - b.ordem);

  if (!etapasComDeps.length) {
    el.innerHTML = '<p class="empty-state">Nenhuma dependência configurada. Edite uma etapa para definir pré-requisitos.</p>';
    return;
  }

  el.innerHTML = etapasComDeps
    .map((e) => {
      const status = computeStatus(e);
      const canStart = canStartEtapa(e);
      const cardClass = status === "concluida" || canStart ? "ok" : status === "bloqueada" ? "blocked" : "pending";
      const deps = getDeps(e);

      const chain = [];

      deps.itens.forEach((id) => {
        const it = state.itens.find((i) => i.id === id);
        if (!it) return;
        const ok = isItemOk(it);
        chain.push(`<div class="dep-card ${ok ? "ok" : "pending"}">
          <div class="dep-card-header">
            <strong>${esc(it.nome)}</strong>
            <span class="badge badge-${it.status}">${ITEM_STATUS_LABELS[it.status]}</span>
          </div>
          <div class="dep-card-type">📦 ${TIPO_LABELS[it.categoria]}</div>
          <div class="dep-card-meta">${ok ? "✓ Quitado" : it.parcelamento?.ativo ? esc(getParcelamentoResumo(it)) : "⏳ Aguardando compra"}</div>
        </div>`);
        chain.push('<div class="dep-arrow">↓</div>');
      });

      deps.etapas.forEach((id) => {
        const dep = state.etapas.find((x) => x.id === id);
        if (!dep) return;
        const ok = isEtapaOk(dep);
        chain.push(`<div class="dep-card ${ok ? "ok" : "pending"}">
          <div class="dep-card-header">
            <strong>${esc(dep.nome)}</strong>
            <span class="badge badge-${computeStatus(dep)}">${STATUS_LABELS[computeStatus(dep)]}</span>
          </div>
          <div class="dep-card-type">📋 Etapa pré-requisito</div>
          <div class="dep-card-meta">${dep.percentualConclusao}% concluída — ${ok ? "✓ Liberada" : "⏳ Em andamento"}</div>
        </div>`);
        chain.push('<div class="dep-arrow">↓</div>');
      });

      if (chain.length && chain[chain.length - 1].includes("dep-arrow")) chain.pop();

      chain.push(`<div class="dep-card ${cardClass}">
        <div class="dep-card-header">
          <strong>${esc(e.nome)}</strong>
          <span class="badge badge-${status}">${STATUS_LABELS[status]}</span>
        </div>
        <div class="dep-card-type">🎯 Etapa destino</div>
        <div class="dep-card-meta">${canStart ? "✓ Pode iniciar" : "🔒 Bloqueada até cumprir pré-requisitos"}</div>
      </div>`);

      return `<article class="panel"><div class="panel-header"><h3>${esc(e.nome)}</h3></div>
        <div class="panel-body dep-flow">${chain.join("")}</div></article>`;
    })
    .join("");
}

/* ── Gastos ── */
function populateEtapaFilter() {
  const sel = document.getElementById("filter-etapa");
  const current = sel.value;
  sel.innerHTML =
    '<option value="">Todas as etapas</option>' +
    state.etapas.map((e) => `<option value="${e.id}">${esc(e.nome)}</option>`).join("");
  sel.value = current;
}

function getFilteredGastos() {
  const etapa = document.getElementById("filter-etapa").value;
  const tipo = document.getElementById("filter-tipo").value;
  const busca = document.getElementById("filter-busca").value.toLowerCase();

  return state.gastos
    .filter((g) => !etapa || g.etapaId === etapa)
    .filter((g) => !tipo || g.tipo === tipo)
    .filter(
      (g) =>
        !busca ||
        (g.fornecedor || "").toLowerCase().includes(busca) ||
        (g.descricao || "").toLowerCase().includes(busca) ||
        (g.nf || "").toLowerCase().includes(busca)
    )
    .sort((a, b) => (b.data || "").localeCompare(a.data || ""));
}

function renderGastos() {
  populateEtapaFilter();
  const gastos = getFilteredGastos();
  const tbody = document.querySelector("#table-gastos tbody");
  let total = 0;

  tbody.innerHTML = gastos.length
    ? gastos
    .map((g) => {
      total += Number(g.valor || 0);
      return `<tr>
        <td data-label="Data">${formatDate(g.data)}</td>
        <td data-label="NF">${esc(g.nf || "—")}${g.comprovante ? ` <span class="gasto-comprovante" data-view-comp="${g.id}" title="Ver comprovante">📎</span>` : ""}</td>
        <td data-label="Fornecedor">${esc(g.fornecedor || "—")}</td>
        <td data-label="Descrição">${esc(g.descricao || "—")}</td>
        <td data-label="Etapa">${esc(getEtapaNome(g.etapaId))}</td>
        <td data-label="Tipo">${TIPO_LABELS[g.tipo] || g.tipo}</td>
        <td data-label="Valor">${formatMoney(Number(g.valor))}</td>
        <td class="td-actions" data-label="">
          <button class="btn btn-ghost btn-sm" data-edit-gasto="${g.id}" type="button">Editar</button>
          <button class="btn-danger" data-del-gasto="${g.id}" type="button">Excluir</button>
        </td>
      </tr>`;
    })
    .join("")
    : '<tr><td colspan="8" class="empty-state" data-label="">Nenhum gasto encontrado</td></tr>';

  document.getElementById("gastos-total").textContent = formatMoney(total);

  tbody.querySelectorAll("[data-edit-gasto]").forEach((btn) => {
    btn.addEventListener("click", () => openGastoModal(btn.dataset.editGasto));
  });
  tbody.querySelectorAll("[data-del-gasto]").forEach((btn) => {
    btn.addEventListener("click", () => deleteGasto(btn.dataset.delGasto));
  });
  tbody.querySelectorAll("[data-view-comp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = state.gastos.find((x) => x.id === btn.dataset.viewComp);
      if (g?.comprovante) viewComprovante(g.comprovante);
    });
  });
}

function openGastoModal(id, prefill = null) {
  const gasto = id ? state.gastos.find((g) => g.id === id) : null;
  const isNew = !gasto;
  const p = prefill || {};
  const comp = gasto?.comprovante || p.comprovante || "";

  document.getElementById("modal-title").textContent = isNew ? "Novo gasto" : "Editar gasto";
  document.getElementById("modal-body").innerHTML = `
    <div class="field-row">
      <label class="field"><span>Data</span>
        <input id="g-data" required type="date" value="${gasto?.data || p.data || new Date().toISOString().slice(0, 10)}" /></label>
      <label class="field"><span>Valor (R$)</span>
        <input id="g-valor" min="0" required step="0.01" type="number" value="${gasto?.valor ?? p.valor ?? ""}" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>NF / Recibo</span>
        <input id="g-nf" type="text" value="${escAttr(gasto?.nf || p.nf || "")}" /></label>
      <label class="field"><span>Fornecedor</span>
        <input id="g-forn" type="text" value="${escAttr(gasto?.fornecedor || p.fornecedor || "")}" /></label>
    </div>
    <label class="field"><span>Descrição</span>
      <input id="g-desc" type="text" value="${escAttr(gasto?.descricao || p.descricao || "")}" /></label>
    <div class="field-row">
      <label class="field"><span>Categoria</span>
        <select id="g-tipo">
          ${Object.entries(TIPO_LABELS)
            .map(([k, v]) => `<option value="${k}" ${(gasto?.tipo || p.tipo) === k ? "selected" : ""}>${v}</option>`)
            .join("")}
        </select></label>
      <label class="field"><span>Etapa</span>
        <select id="g-etapa">
          <option value="">Sem etapa</option>
          ${state.etapas.map((e) => `<option value="${e.id}" ${(gasto?.etapaId || p.etapaId) === e.id ? "selected" : ""}>${esc(e.nome)}</option>`).join("")}
        </select></label>
    </div>
    <label class="field"><span>Vincular a item</span>
      <select id="g-item" ${p.itemId ? "disabled" : ""}>
        <option value="">Nenhum</option>
        ${state.itens.map((i) => `<option value="${i.id}" ${(gasto?.itemId || p.itemId) === i.id ? "selected" : ""}>${esc(i.nome)}</option>`).join("")}
      </select>
      <input id="g-parcela" type="hidden" value="${escAttr(gasto?.parcelaId || p.parcelaId || "")}" />
      <p class="field-hint">${p.parcelaId ? "Pagamento de parcela — ao salvar, a parcela será marcada como paga." : "Ao vincular, o item é marcado como comprado (ou a parcela, se parcelado)."}</p>
    </label>
    ${comp ? `<div class="field"><span>Comprovante anexo</span><img alt="Comprovante" src="${comp}" style="max-width:100%;max-height:120px;border-radius:8px;border:1px solid var(--border)"/></div>` : ""}`;

  const modal = document.getElementById("modal");
  modal.showModal();
  let comprovanteAnexo = comp;

  document.getElementById("modal-form").onsubmit = (ev) => {
    ev.preventDefault();
    const data = {
      data: document.getElementById("g-data").value,
      valor: Number(document.getElementById("g-valor").value) || 0,
      nf: document.getElementById("g-nf").value.trim(),
      fornecedor: document.getElementById("g-forn").value.trim(),
      descricao: document.getElementById("g-desc").value.trim(),
      etapaId: document.getElementById("g-etapa").value,
      tipo: document.getElementById("g-tipo").value,
      itemId: document.getElementById("g-item").value || p.itemId || "",
      parcelaId: document.getElementById("g-parcela").value,
      comprovante: comprovanteAnexo || gasto?.comprovante || "",
    };

    let saved;
    if (isNew) {
      saved = { id: uid(), ...data };
      state.gastos.push(saved);
    } else {
      Object.assign(gasto, data);
      saved = gasto;
    }

    syncItemFromGasto(saved);

    modal.close();
    scheduleSave();
    render();
  };
}

function deleteGasto(id) {
  if (!confirm("Excluir este gasto?")) return;
  const gasto = state.gastos.find((g) => g.id === id);
  if (gasto?.parcelaId && gasto.itemId) {
    const { item, parcela } = findParcela(gasto.itemId, gasto.parcelaId);
    if (parcela) {
      parcela.paga = false;
      parcela.gastoId = "";
      syncItemStatusFromParcelas(item);
    }
  }
  state.gastos = state.gastos.filter((g) => g.id !== id);
  scheduleSave();
  render();
}

/* ── Gantt ── */
function renderGantt() {
  const el = document.getElementById("gantt");
  const etapas = [...state.etapas].sort((a, b) => a.ordem - b.ordem);

  if (!etapas.length) {
    el.innerHTML = '<p class="empty-state">Adicione etapas para ver o cronograma</p>';
    return;
  }

  const dates = [];
  etapas.forEach((e) => {
    if (e.dataInicio) dates.push(parseDate(e.dataInicio));
    if (e.dataFimPrevisto) dates.push(parseDate(e.dataFimPrevisto));
    if (e.dataFimReal) dates.push(parseDate(e.dataFimReal));
  });

  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  dates.push(hoje);

  const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
  minDate.setDate(1);
  maxDate.setMonth(maxDate.getMonth() + 1);
  maxDate.setDate(0);

  const totalMs = maxDate - minDate;
  const pct = (date) => ((date - minDate) / totalMs) * 100;
  const barStyle = (start, end) => {
    const s = parseDate(start);
    const e = parseDate(end);
    if (!s || !e) return null;
    const left = pct(s);
    const width = Math.max(pct(e) - left, 0.5);
    return `left:${left}%;width:${width}%`;
  };

  const months = [];
  let m = new Date(minDate);
  while (m <= maxDate) {
    months.push(new Date(m));
    m.setMonth(m.getMonth() + 1);
  }

  const monthsHtml = months
    .map((mo) => {
      const left = pct(mo);
      const label = mo.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });
      return `<span class="gantt-month" style="left:${left}%">${label}</span>`;
    })
    .join("");

  const rowsHtml = etapas
    .map((e) => {
      const blocked = computeStatus(e) === "bloqueada";
      const prevStyle = !blocked ? barStyle(e.dataInicio, e.dataFimPrevisto) : null;
      const realEnd = e.dataFimReal || (Number(e.percentualConclusao) >= 100 ? e.dataFimPrevisto : null);
      const realStyle = realEnd && e.dataInicio ? barStyle(e.dataInicio, realEnd) : null;
      const atrasoStyle =
        computeStatus(e) === "atrasada" && e.dataFimPrevisto
          ? barStyle(e.dataFimPrevisto, hoje.toISOString().slice(0, 10))
          : null;

      return `<div class="gantt-row">
        <div class="gantt-label" title="${escAttr(e.nome)}">${blocked ? "🔒 " : ""}${esc(e.nome)}</div>
        <div class="gantt-track">
          ${prevStyle ? `<div class="gantt-bar prev" style="${prevStyle}"></div>` : ""}
          ${realStyle ? `<div class="gantt-bar real" style="${realStyle}"></div>` : ""}
          ${atrasoStyle ? `<div class="gantt-bar atraso" style="${atrasoStyle}"></div>` : ""}
          <div class="gantt-today" style="left:${pct(hoje)}%"></div>
        </div>
      </div>`;
    })
    .join("");

  el.innerHTML = `
    <div class="gantt-header">
      <div>Etapa</div>
      <div class="gantt-months">${monthsHtml}</div>
    </div>
    ${rowsHtml}`;
}

/* ── Charts ── */
function renderCharts() {
  if (typeof Chart === "undefined") return;

  const chartColors = { text: "#64748b", grid: "rgba(148,163,184,0.2)" };
  const etapas = [...state.etapas].sort((a, b) => a.ordem - b.ordem);

  destroyChart("chart-etapas");
  charts.etapas = new Chart(document.getElementById("chart-etapas"), {
    type: "bar",
    data: {
      labels: etapas.map((e) => e.nome),
      datasets: [
        { label: "Previsto", data: etapas.map((e) => Number(e.orcamentoPrevisto || 0)), backgroundColor: "rgba(37,99,235,0.7)" },
        { label: "Realizado", data: etapas.map((e) => getGastoEtapa(e.id)), backgroundColor: "rgba(22,163,74,0.7)" },
      ],
    },
    options: chartOpts(true, chartColors),
  });

  const tipos = {};
  state.gastos.forEach((g) => {
    const t = g.tipo || "material_obra";
    tipos[t] = (tipos[t] || 0) + Number(g.valor || 0);
  });

  destroyChart("chart-tipos");
  charts.tipos = new Chart(document.getElementById("chart-tipos"), {
    type: "doughnut",
    data: {
      labels: Object.keys(tipos).map((k) => TIPO_LABELS[k] || k),
      datasets: [{
        data: Object.values(tipos),
        backgroundColor: ["#d97706", "#2563eb", "#7c3aed", "#db2777", "#16a34a"],
      }],
    },
    options: {
      ...chartOpts(false, chartColors),
      plugins: { legend: { position: "bottom", labels: { color: chartColors.text } } },
    },
  });

  const mensal = {};
  state.gastos.forEach((g) => {
    if (!g.data) return;
    const key = g.data.slice(0, 7);
    mensal[key] = (mensal[key] || 0) + Number(g.valor || 0);
  });
  const meses = Object.keys(mensal).sort();

  destroyChart("chart-mensal");
  charts.mensal = new Chart(document.getElementById("chart-mensal"), {
    type: "line",
    data: {
      labels: meses.map((m) => { const [y, mo] = m.split("-"); return `${mo}/${y}`; }),
      datasets: [{
        label: "Gastos (R$)",
        data: meses.map((m) => mensal[m]),
        borderColor: "#d97706",
        backgroundColor: "rgba(217,119,6,0.12)",
        fill: true,
        tension: 0.3,
      }],
    },
    options: chartOpts(true, chartColors),
  });

  const curva = buildCurvaFisicoFinanceira();
  destroyChart("chart-curva");
  charts.curva = new Chart(document.getElementById("chart-curva"), {
    type: "line",
    data: {
      labels: curva.labels,
      datasets: [
        { label: "Avanço físico (%)", data: curva.fisico, borderColor: "#2563eb", tension: 0.3 },
        { label: "Execução financeira (%)", data: curva.financeiro, borderColor: "#16a34a", tension: 0.3 },
      ],
    },
    options: {
      ...chartOpts(false, chartColors),
      scales: {
        x: { ticks: { color: chartColors.text }, grid: { color: chartColors.grid } },
        y: {
          min: 0, max: 100,
          ticks: { color: chartColors.text, callback: (v) => v + "%" },
          grid: { color: chartColors.grid },
        },
      },
    },
  });
}

function buildCurvaFisicoFinanceira() {
  const ini = state.projeto.dataInicio;
  const fim = state.projeto.dataFimPrevisto;
  if (!ini || !fim) return { labels: [], fisico: [], financeiro: [] };

  const start = parseDate(ini);
  const end = parseDate(fim);
  const totalOrc = getTotalOrcamento();
  const labels = [], fisico = [], financeiro = [];

  let m = new Date(start.getFullYear(), start.getMonth(), 1);
  while (m <= end) {
    const cutoff = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    labels.push(m.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }));

    let fis = 0;
    state.etapas.forEach((e) => {
      const peso = totalOrc > 0 ? Number(e.orcamentoPrevisto || 0) / totalOrc : 1 / state.etapas.length;
      const fimEtapa = parseDate(e.dataFimReal || e.dataFimPrevisto);
      if (fimEtapa && fimEtapa <= cutoff) fis += peso * 100;
      else if (parseDate(e.dataInicio) && parseDate(e.dataInicio) <= cutoff) {
        fis += peso * Number(e.percentualConclusao || 0);
      }
    });
    fisico.push(Math.min(100, fis));

    const gastoAte = state.gastos
      .filter((g) => g.data && parseDate(g.data) <= cutoff)
      .reduce((s, g) => s + Number(g.valor || 0), 0);
    financeiro.push(totalOrc > 0 ? Math.min(100, (gastoAte / totalOrc) * 100) : 0);

    m.setMonth(m.getMonth() + 1);
  }

  return { labels, fisico, financeiro };
}

function chartOpts(money, colors) {
  const compact = window.matchMedia("(max-width: 900px)").matches;
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: colors.text,
          boxWidth: compact ? 10 : 12,
          font: { size: compact ? 10 : 12 },
        },
      },
    },
    scales: money ? {
      x: {
        ticks: { color: colors.text, maxRotation: compact ? 60 : 45, font: { size: compact ? 10 : 12 } },
        grid: { color: colors.grid },
      },
      y: {
        ticks: {
          color: colors.text,
          font: { size: compact ? 10 : 12 },
          callback: (v) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }),
        },
        grid: { color: colors.grid },
      },
    } : undefined,
  };
}

function destroyChart(id) {
  const key = id.replace("chart-", "");
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

/* ── Escanear comprovante (IA) ── */
let scanImageDataUrl = "";
let scanMimeType = "image/jpeg";

function matchByName(list, nome, key = "nome") {
  if (!nome) return "";
  const n = nome.toLowerCase().trim();
  const exact = list.find((x) => x[key].toLowerCase() === n);
  if (exact) return exact.id;
  const partial = list.find((x) => x[key].toLowerCase().includes(n) || n.includes(x[key].toLowerCase()));
  return partial?.id || "";
}

function compressImage(file, maxWidth = 900) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function buildScanPrompt() {
  const etapas = state.etapas.map((e) => e.nome).join(", ") || "nenhuma";
  const itens = state.itens.map((i) => i.nome).join(", ") || "nenhum";
  return `Analise esta imagem de comprovante de compra, nota fiscal ou recibo de obra no Brasil.
Extraia os dados e retorne APENAS um JSON válido (sem markdown, sem texto extra):
{
  "fornecedor": "nome do estabelecimento ou prestador",
  "valor": 0.00,
  "data": "YYYY-MM-DD",
  "nf": "número da nota ou recibo",
  "descricao": "resumo do que foi comprado ou contratado",
  "tipo": "material_obra|equipamento|utensilio|contratacao|mao_de_obra",
  "etapa_sugerida": "nome da etapa se inferível",
  "item_sugerido": "nome do item/material se inferível",
  "confianca": "alta|media|baixa"
}

Regras:
- valor: número decimal (total pago)
- tipo: escolha a categoria mais adequada
- etapa_sugerida: tente associar a uma destas etapas cadastradas: ${etapas}
- item_sugerido: tente associar a um destes itens cadastrados: ${itens}
- Se não encontrar data, use ${new Date().toISOString().slice(0, 10)}
- Campos vazios: use string vazia`;
}

async function analyzeComprovanteWithAI(dataUrl) {
  const apiKey = state.projeto.geminiApiKey?.trim();
  if (!apiKey) {
    throw new Error("Configure a chave API Gemini em ⚙️ Projeto para usar a leitura automática.");
  }

  const base64 = dataUrl.split(",")[1];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: buildScanPrompt() },
            { inline_data: { mime_type: scanMimeType, data: base64 } },
          ],
        }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Erro na API (${res.status}). Verifique a chave Gemini.`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("A IA não retornou dados. Tente outra foto mais nítida.");

  const parsed = JSON.parse(text);
  const tiposValidos = Object.keys(TIPO_LABELS);
  if (!tiposValidos.includes(parsed.tipo)) parsed.tipo = "material_obra";
  parsed.valor = Number(parsed.valor) || 0;
  parsed.etapaId = matchByName(state.etapas, parsed.etapa_sugerida);
  parsed.itemId = matchByName(state.itens, parsed.item_sugerido);
  return parsed;
}

function resetScanModal() {
  scanImageDataUrl = "";
  document.getElementById("scan-dropzone").classList.remove("hidden");
  document.getElementById("scan-preview-wrap").classList.add("hidden");
  document.getElementById("scan-loading").classList.add("hidden");
  document.getElementById("scan-result").classList.add("hidden");
  document.getElementById("scan-analyze").classList.add("hidden");
  document.getElementById("scan-analyze").disabled = true;
  document.getElementById("scan-file").value = "";
}

function openScanModal() {
  resetScanModal();
  if (!state.projeto.geminiApiKey?.trim()) {
    document.getElementById("scan-result").classList.remove("hidden");
    document.getElementById("scan-result").innerHTML = `
      <div class="scan-confianca baixa">
        ⚠️ Para a IA ler comprovantes, configure sua chave API Gemini em <strong>⚙️ Projeto</strong>.
        <br><br>
        <a href="https://aistudio.google.com/apikey" rel="noopener" target="_blank">Obter chave grátis →</a>
      </div>`;
    document.getElementById("scan-dropzone").classList.add("hidden");
  }
  document.getElementById("modal-scan").showModal();
}

async function handleScanFile(file) {
  if (!file || !file.type.startsWith("image/")) {
    alert("Selecione uma imagem (JPG, PNG, etc.).");
    return;
  }
  scanMimeType = file.type === "image/png" ? "image/png" : "image/jpeg";
  scanImageDataUrl = await compressImage(file);
  document.getElementById("scan-preview").src = scanImageDataUrl;
  document.getElementById("scan-dropzone").classList.add("hidden");
  document.getElementById("scan-preview-wrap").classList.remove("hidden");
  document.getElementById("scan-result").classList.add("hidden");
  const btn = document.getElementById("scan-analyze");
  btn.classList.remove("hidden");
  btn.disabled = !state.projeto.geminiApiKey?.trim();
}

function renderScanResult(data) {
  const el = document.getElementById("scan-result");
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="scan-confianca ${esc(data.confianca || "media")}">
      Confiança da leitura: <strong>${esc(data.confianca || "média")}</strong> — confira os dados antes de salvar.
    </div>
    <div class="scan-result-grid">
      <div class="field-row">
        <label class="field"><span>Fornecedor</span>
          <input id="sr-forn" type="text" value="${escAttr(data.fornecedor || "")}" /></label>
        <label class="field"><span>Valor (R$)</span>
          <input id="sr-valor" min="0" step="0.01" type="number" value="${data.valor || ""}" /></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Data</span>
          <input id="sr-data" type="date" value="${data.data || new Date().toISOString().slice(0, 10)}" /></label>
        <label class="field"><span>NF / Recibo</span>
          <input id="sr-nf" type="text" value="${escAttr(data.nf || "")}" /></label>
      </div>
      <label class="field"><span>Descrição</span>
        <input id="sr-desc" type="text" value="${escAttr(data.descricao || "")}" /></label>
      <div class="field-row">
        <label class="field"><span>Categoria</span>
          <select id="sr-tipo">
            ${Object.entries(TIPO_LABELS)
              .map(([k, v]) => `<option value="${k}" ${data.tipo === k ? "selected" : ""}>${v}</option>`)
              .join("")}
          </select></label>
        <label class="field"><span>Etapa</span>
          <select id="sr-etapa">
            <option value="">Sem etapa</option>
            ${state.etapas.map((e) => `<option value="${e.id}" ${data.etapaId === e.id ? "selected" : ""}>${esc(e.nome)}</option>`).join("")}
          </select></label>
      </div>
      <label class="field"><span>Item vinculado</span>
        <select id="sr-item">
          <option value="">Nenhum</option>
          ${state.itens.map((i) => `<option value="${i.id}" ${data.itemId === i.id ? "selected" : ""}>${esc(i.nome)}</option>`).join("")}
        </select></label>
    </div>
    <button class="btn btn-block" id="scan-save" type="button">✓ Salvar gasto no sistema</button>
    <button class="btn btn-ghost btn-block" id="scan-edit-more" type="button">Abrir formulário completo</button>`;

  document.getElementById("scan-save").addEventListener("click", () => {
    const gasto = {
      id: uid(),
      data: document.getElementById("sr-data").value,
      valor: Number(document.getElementById("sr-valor").value) || 0,
      nf: document.getElementById("sr-nf").value.trim(),
      fornecedor: document.getElementById("sr-forn").value.trim(),
      descricao: document.getElementById("sr-desc").value.trim(),
      etapaId: document.getElementById("sr-etapa").value,
      tipo: document.getElementById("sr-tipo").value,
      itemId: document.getElementById("sr-item").value,
      parcelaId: "",
      comprovante: scanImageDataUrl,
    };
    if (!gasto.valor) { alert("Informe o valor."); return; }
    state.gastos.push(gasto);
    syncItemFromGasto(gasto);
    document.getElementById("modal-scan").close();
    scheduleSave();
    switchView("gastos");
    alert("Gasto registrado com sucesso!");
  });

  document.getElementById("scan-edit-more").addEventListener("click", () => {
    const prefill = {
      data: document.getElementById("sr-data").value,
      valor: Number(document.getElementById("sr-valor").value) || 0,
      nf: document.getElementById("sr-nf").value.trim(),
      fornecedor: document.getElementById("sr-forn").value.trim(),
      descricao: document.getElementById("sr-desc").value.trim(),
      etapaId: document.getElementById("sr-etapa").value,
      tipo: document.getElementById("sr-tipo").value,
      itemId: document.getElementById("sr-item").value,
      comprovante: scanImageDataUrl,
    };
    document.getElementById("modal-scan").close();
    openGastoModal(null, prefill);
  });
}

async function runScanAnalysis() {
  if (!scanImageDataUrl) return;
  document.getElementById("scan-loading").classList.remove("hidden");
  document.getElementById("scan-analyze").disabled = true;
  try {
    const data = await analyzeComprovanteWithAI(scanImageDataUrl);
    renderScanResult(data);
  } catch (err) {
    alert(err.message || "Erro ao analisar imagem.");
  } finally {
    document.getElementById("scan-loading").classList.add("hidden");
    document.getElementById("scan-analyze").disabled = false;
  }
}

function initScan() {
  ["fab-scan", "btn-scan-top", "btn-scan-gastos"].forEach((id) => {
    document.getElementById(id)?.addEventListener("click", openScanModal);
  });

  const dropzone = document.getElementById("scan-dropzone");
  const fileInput = document.getElementById("scan-file");

  dropzone.addEventListener("click", () => fileInput.click());
  document.getElementById("scan-browse").addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files[0]) handleScanFile(fileInput.files[0]);
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer.files[0]) handleScanFile(e.dataTransfer.files[0]);
  });

  document.getElementById("scan-retake").addEventListener("click", resetScanModal);
  document.getElementById("scan-analyze").addEventListener("click", runScanAnalysis);

  ["modal-scan-close", "modal-scan-cancel"].forEach((id) => {
    document.getElementById(id).addEventListener("click", () => {
      document.getElementById("modal-scan").close();
    });
  });
}

function viewComprovante(dataUrl) {
  const w = window.open("", "_blank");
  if (w) {
    w.document.write(`<html><head><title>Comprovante</title></head><body style="margin:0;background:#111;display:flex;justify-content:center"><img src="${dataUrl}" style="max-width:100%;height:auto"/></body></html>`);
  }
}

/* ── Projeto / Backup / Modals ── */
function initProjeto() {
  document.getElementById("btn-projeto").addEventListener("click", () => {
    const p = state.projeto;
    document.getElementById("proj-nome").value = p.nome;
    document.getElementById("proj-endereco").value = p.endereco;
    document.getElementById("proj-inicio").value = p.dataInicio;
    document.getElementById("proj-fim").value = p.dataFimPrevisto;
    document.getElementById("proj-orcamento").value = p.orcamentoGlobal || "";
    document.getElementById("proj-responsavel").value = p.responsavel;
    document.getElementById("proj-obs").value = p.observacoes;
    document.getElementById("proj-gemini-key").value = p.geminiApiKey || "";
    document.getElementById("modal-projeto").showModal();
  });

  document.getElementById("form-projeto").addEventListener("submit", (ev) => {
    ev.preventDefault();
    state.projeto = {
      nome: document.getElementById("proj-nome").value.trim() || "Obra 103",
      endereco: document.getElementById("proj-endereco").value.trim(),
      dataInicio: document.getElementById("proj-inicio").value,
      dataFimPrevisto: document.getElementById("proj-fim").value,
      orcamentoGlobal: Number(document.getElementById("proj-orcamento").value) || 0,
      responsavel: document.getElementById("proj-responsavel").value.trim(),
      observacoes: document.getElementById("proj-obs").value.trim(),
      geminiApiKey: document.getElementById("proj-gemini-key").value.trim(),
    };
    document.getElementById("sidebar-title").textContent = state.projeto.nome;
    document.title = `${state.projeto.nome} — Cronograma & Controle de Gastos`;
    document.getElementById("modal-projeto").close();
    scheduleSave();
    render();
  });

  ["modal-projeto-close", "modal-projeto-cancel"].forEach((id) => {
    document.getElementById(id).addEventListener("click", () => {
      document.getElementById("modal-projeto").close();
    });
  });
}

function initBackup() {
  document.getElementById("btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${state.projeto.nome.replace(/\s+/g, "_")}_backup.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById("import-file").addEventListener("change", (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        state = migrateState(JSON.parse(reader.result));
        saveStateNow().then(() => {
          render();
          alert("Backup importado com sucesso!");
        });
      } catch {
        alert("Arquivo inválido.");
      }
    };
    reader.readAsText(file);
    ev.target.value = "";
  });
}

function initModals() {
  ["modal-close", "modal-cancel"].forEach((id) => {
    document.getElementById(id).addEventListener("click", () => {
      document.getElementById("modal").close();
    });
  });
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function escAttr(str) {
  return esc(str).replace(/"/g, "&quot;");
}

function render() {
  document.getElementById("sidebar-title").textContent = state.projeto.nome;
  renderDashboard();
  renderEtapas();
  renderItens();
  renderDependencias();
  renderGastos();
  renderGantt();
  const activeView = document.querySelector(".view.active")?.id;
  if (activeView === "view-relatorios") renderCharts();
}

/* ── Tutorial ── */
let tutorialStep = 0;

function renderTutorialStep() {
  const step = TUTORIAL_STEPS[tutorialStep];
  document.getElementById("tutorial-title").textContent = step.title;
  document.getElementById("tutorial-body").innerHTML = `
    <div class="tutorial-step-icon">${step.icon}</div>
    ${step.html}
    ${step.action ? `<button class="btn btn-sm" id="tutorial-goto" type="button">Ir para esta seção →</button>` : ""}`;

  document.getElementById("tutorial-progress").innerHTML = TUTORIAL_STEPS.map((_, i) => {
    const cls = i === tutorialStep ? "active" : i < tutorialStep ? "done" : "";
    return `<div class="tutorial-dot ${cls}"></div>`;
  }).join("");

  document.getElementById("tutorial-prev").disabled = tutorialStep === 0;
  document.getElementById("tutorial-next").textContent =
    tutorialStep === TUTORIAL_STEPS.length - 1 ? "Começar" : "Próximo";

  const gotoBtn = document.getElementById("tutorial-goto");
  if (gotoBtn) {
    gotoBtn.addEventListener("click", () => {
      document.getElementById("modal-tutorial").close();
      if (step.action === "projeto") {
        document.getElementById("btn-projeto").click();
      } else {
        switchView(step.action);
      }
    });
  }
}

function showTutorial() {
  tutorialStep = 0;
  renderTutorialStep();
  document.getElementById("modal-tutorial").showModal();
}

function getTutorialKey() {
  const uid = window.ObraAuth?.getUser?.()?.id;
  return uid ? `${TUTORIAL_KEY}-${uid}` : TUTORIAL_KEY;
}

function closeTutorial() {
  document.getElementById("modal-tutorial").close();
  localStorage.setItem(getTutorialKey(), "1");
}

function initTutorial() {
  document.getElementById("btn-tutorial").addEventListener("click", showTutorial);
  document.getElementById("tutorial-skip").addEventListener("click", closeTutorial);
  document.getElementById("tutorial-prev").addEventListener("click", () => {
    if (tutorialStep > 0) {
      tutorialStep--;
      renderTutorialStep();
    }
  });
  document.getElementById("tutorial-next").addEventListener("click", () => {
    if (tutorialStep < TUTORIAL_STEPS.length - 1) {
      tutorialStep++;
      renderTutorialStep();
    } else {
      closeTutorial();
    }
  });
}

function maybeShowFirstAccessTutorial() {
  if (!localStorage.getItem(getTutorialKey())) {
    if (!window.ObraAuth?.isCloud?.()) {
      state = defaultState();
      saveState();
    }
    render();
    setTimeout(showTutorial, 500);
  }
}

function startApp(initialState) {
  const raw = initialState ?? loadState();
  const before = JSON.stringify(raw);
  state = migrateState(typeof raw === "object" ? JSON.parse(JSON.stringify(raw)) : raw);
  if (JSON.stringify(state) !== before) {
    scheduleSave();
  }

  if (window.ObraAuth?.isCloud?.()) {
    document.getElementById("btn-logout")?.classList.remove("hidden");
  }

  initNav();
  initProjeto();
  initBackup();
  initModals();
  initTutorial();
  initScan();

  document.getElementById("btn-add-etapa").addEventListener("click", () => openEtapaModal(null));
  document.getElementById("btn-add-item").addEventListener("click", () => openItemModal(null));
  document.getElementById("btn-add-gasto").addEventListener("click", () => openGastoModal(null));

  ["filter-etapa", "filter-tipo", "filter-busca"].forEach((id) => {
    document.getElementById(id).addEventListener("input", renderGastos);
    document.getElementById(id).addEventListener("change", renderGastos);
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (document.querySelector("#view-relatorios.active")) renderCharts();
    }, 200);
  });

  render();
  maybeShowFirstAccessTutorial();
}

function init() {
  ObraAuth.init(({ mode, state: cloudState }) => {
    if (mode === "cloud") {
      startApp(cloudState ?? defaultState());
      return;
    }
    startApp(loadState());
  });
}

document.addEventListener("DOMContentLoaded", init);
