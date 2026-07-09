(function () {
  const STORAGE_KEY = "obra103-data-v2";

  let supabase = null;
  let currentUser = null;
  let onReady = null;
  let saveTimer = null;
  let resolvedConfig = null;

  function getRawConfig() {
    return window.OBRA_CONFIG || {};
  }

  function decodeJwtPayload(token) {
    const part = token.split(".")[1];
    if (!part) return null;
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return JSON.parse(json);
  }

  function resolveSupabaseConfig() {
    const raw = getRawConfig();
    const key = (raw.supabaseAnonKey || "").trim();
    let url = (raw.supabaseUrl || "").trim().replace(/\/$/, "");

    if (key.startsWith("eyJ")) {
      try {
        const payload = decodeJwtPayload(key);
        if (payload?.ref) {
          url = `https://${payload.ref}.supabase.co`;
        }
      } catch (_) {}
    }

    return { url, key };
  }

  function isConfigured() {
    const { url, key } = resolveSupabaseConfig();
    return Boolean(url && key);
  }

  function $(id) {
    return document.getElementById(id);
  }

  function setAuthView(view) {
    $("auth-loading")?.classList.toggle("hidden", view !== "loading");
    $("login-screen")?.classList.toggle("hidden", view !== "login");
    $("app-root")?.classList.toggle("hidden", view !== "app");
  }

  function updateLoginDebug() {
    const el = $("login-debug");
    if (!el || !resolvedConfig?.url) return;
    el.textContent = `Projeto: ${resolvedConfig.url.replace("https://", "")}`;
  }

  function updateUserUI() {
    const el = $("user-chip");
    if (!el || !currentUser) return;

    const meta = currentUser.user_metadata || {};
    const name = meta.full_name || meta.name || currentUser.email || "Usuário";
    const avatar = meta.avatar_url || meta.picture || "";

    el.innerHTML = avatar
      ? `<img alt="" class="user-avatar" src="${avatar}" /><span class="user-name">${escapeHtml(name)}</span>`
      : `<span class="user-name">${escapeHtml(name)}</span>`;
    el.classList.remove("hidden");
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  async function verifySupabaseReachable(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${url}/auth/v1/health`, { signal: controller.signal });
      return res.ok;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function createSupabaseClient() {
    resolvedConfig = resolveSupabaseConfig();
    updateLoginDebug();
    return window.supabase.createClient(resolvedConfig.url, resolvedConfig.key);
  }

  async function loadCloudState(userId) {
    const { data, error } = await supabase
      .from("obra_data")
      .select("data")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    if (data?.data) return data.data;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const local = JSON.parse(raw);
        await persistState(userId, local);
        return local;
      }
    } catch (_) {}

    return null;
  }

  async function persistState(userId, stateData) {
    const { error } = await supabase.from("obra_data").upsert(
      {
        user_id: userId,
        data: stateData,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) throw error;
  }

  async function handleSession(session) {
    currentUser = session.user;
    setAuthView("loading");
    updateUserUI();

    let cloudState = null;
    try {
      cloudState = await loadCloudState(session.user.id);
    } catch (err) {
      console.error(err);
      alert("Não foi possível carregar os dados da nuvem. Tente novamente.");
      await supabase.auth.signOut();
      setAuthView("login");
      return;
    }

    setAuthView("app");
    onReady?.({ mode: "cloud", user: session.user, state: cloudState });
  }

  function handleSignOut() {
    currentUser = null;
    $("user-chip")?.classList.add("hidden");
    setAuthView("login");
  }

  async function init(callback) {
    onReady = callback;

    $("btn-google-login")?.addEventListener("click", signInWithGoogle);
    $("btn-logout")?.addEventListener("click", signOut);

    if (!isConfigured()) {
      setAuthView("app");
      onReady?.({ mode: "local", user: null, state: null });
      return;
    }

    setAuthView("loading");
    resolvedConfig = resolveSupabaseConfig();

    const reachable = await verifySupabaseReachable(resolvedConfig.url);
    if (!reachable) {
      setAuthView("login");
      updateLoginDebug();
      $("login-error")?.classList.remove("hidden");
      return;
    }

    supabase = createSupabaseClient();

    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      await handleSession(session);
    } else {
      setAuthView("login");
      updateLoginDebug();
    }

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_IN" && session?.user) {
        await handleSession(session);
      }
      if (event === "SIGNED_OUT") {
        handleSignOut();
      }
    });
  }

  async function signInWithGoogle() {
    if (!supabase) {
      supabase = createSupabaseClient();
    }

    const btn = $("btn-google-login");
    if (btn) btn.disabled = true;
    $("login-error")?.classList.add("hidden");

    try {
      const reachable = await verifySupabaseReachable(resolvedConfig.url);
      if (!reachable) {
        throw new Error(
          `Não foi possível conectar ao Supabase em ${resolvedConfig.url}. Copie a URL exata em Project Settings → API.`
        );
      }

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.origin + window.location.pathname,
        },
      });
      if (error) throw error;
    } catch (err) {
      alert(err.message || "Erro ao entrar com Google.");
      $("login-error")?.classList.remove("hidden");
      if (btn) btn.disabled = false;
    }
  }

  async function signOut() {
    if (!supabase) return;
    if (!confirm("Sair da conta? Os dados continuam salvos na nuvem.")) return;
    await supabase.auth.signOut();
    window.location.reload();
  }

  function scheduleCloudSave(stateData) {
    if (!currentUser || !supabase) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await persistState(currentUser.id, stateData);
      } catch (err) {
        console.error(err);
      }
    }, 800);
  }

  async function saveNow(stateData) {
    if (!currentUser || !supabase) return;
    await persistState(currentUser.id, stateData);
  }

  window.ObraAuth = {
    init,
    isConfigured,
    isCloud: () => Boolean(currentUser),
    getUser: () => currentUser,
    scheduleCloudSave,
    saveNow,
    signInWithGoogle,
    signOut,
  };
})();
