import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../config/constants.js";

export function createSupabaseService() {
  let supabase = null;

  function getSupabaseClient() {
    if (!supabase && window.supabase?.createClient) {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return supabase;
  }

  async function ensureSupabaseLoaded(timeoutMs = 3000) {
    if (window.supabase?.createClient) return true;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
      if (window.supabase?.createClient) return true;
    }

    return false;
  }

  async function insertConfig(payload) {
    const sdkReady = await ensureSupabaseLoaded();
    const client = sdkReady ? getSupabaseClient() : null;

    if (client) {
      const { error } = await client.from("configs").insert(payload);
      if (error) throw new Error(error.message || "Supabase SDK insert failed");
      return;
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/configs`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        msg = data?.message || data?.error || msg;
      } catch (_) {
        // ignore parse error
      }
      throw new Error(msg);
    }
  }

  async function fetchConfigs() {
    const sdkReady = await ensureSupabaseLoaded(1200);
    const client = sdkReady ? getSupabaseClient() : null;

    if (client) {
      const { data, error } = await client.from("configs").select("*").limit(200);
      if (error) throw new Error(error.message || "Không tải được danh sách");
      return data || [];
    }

    const res = await fetch(`${SUPABASE_URL}/rest/v1/configs?select=*`, {
      method: "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }

  return {
    insertConfig,
    fetchConfigs,
  };
}
