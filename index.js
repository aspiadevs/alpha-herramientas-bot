const express = require("express");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURACIÓN — Variables de entorno (Railway > Variables)
// ============================================================
const {
  PORT = 3000,
  ANTHROPIC_API_KEY,
  META_ACCESS_TOKEN,
  WHATSAPP_PHONE_ID,
  WEBHOOK_VERIFY_TOKEN,
  JUMPSELLER_LOGIN,
  JUMPSELLER_TOKEN,
  MONTHLY_AI_BUDGET = "15",
} = process.env;

// ============================================================
// CLIENTE CLAUDE
// ============================================================
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ============================================================
// CONTROL DE GASTO MENSUAL
// ============================================================
let monthlySpend = 0;
let currentMonth = new Date().getMonth();
const HAIKU_INPUT_COST = 1 / 1_000_000;
const HAIKU_OUTPUT_COST = 5 / 1_000_000;

function trackSpend(inputTokens, outputTokens) {
  const now = new Date();
  if (now.getMonth() !== currentMonth) {
    monthlySpend = 0;
    currentMonth = now.getMonth();
    console.log("[GASTO] Nuevo mes, contador reseteado");
  }
  monthlySpend +=
    inputTokens * HAIKU_INPUT_COST + outputTokens * HAIKU_OUTPUT_COST;
}

function isBudgetExceeded() {
  return monthlySpend >= parseFloat(MONTHLY_AI_BUDGET);
}

// ============================================================
// CACHE DE PRODUCTOS — Jumpseller API
// ============================================================
let productCache = [];
let cacheTimestamp = 0;
const CACHE_DURATION = 15 * 60 * 1000;

async function fetchProducts() {
  const now = Date.now();
  if (productCache.length > 0 && now - cacheTimestamp < CACHE_DURATION) {
    return productCache;
  }

  try {
    const allProducts = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const url = `https://api.jumpseller.com/v1/products.json?login=${JUMPSELLER_LOGIN}&authtoken=${JUMPSELLER_TOKEN}&limit=100&page=${page}`;
      const res = await fetch(url);

      if (!res.ok) {
        console.error(`[JUMPSELLER] Error HTTP ${res.status} en página ${page}`);
        break;
      }

      const data = await res.json();
      if (!data || data.length === 0) {
        hasMore = false;
      } else {
        allProducts.push(...data.map((p) => p.product));
        page++;
        await new Promise((r) => setTimeout(r, 600));
      }
    }

    productCache = allProducts;
    cacheTimestamp = now;
    console.log(`[CACHE] ${productCache.length} productos cargados`);
  } catch (err) {
    console.error("[CACHE] Error:", err.message);
  }

  return productCache;
}

function searchProducts(query, products) {
  const terms = query
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 2);

  if (terms.length === 0)
    return products.filter((p) => p.status === "available").slice(0, 30);

  const scored = products
    .filter((p) => p.status === "available")
    .map((p) => {
      const searchText =
        `${p.name} ${p.brand || ""} ${p.sku || ""} ${p.description || ""}`
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");

      let score = 0;
      for (const term of terms) {
        if (searchText.includes(term)) score++;
      }
      return { product: p, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  if (scored.length === 0)
    return products.filter((p) => p.status === "available").slice(0, 15);

  return scored.map((item) => item.product);
}

function formatProductsForContext(products) {
  return products
    .map((p) => {
      const price = p.price
        ? `$${Math.round(p.price).toLocaleString("es-CL")} CLP`
        : "Consultar precio";
      const stock =
        p.stock !== undefined && p.stock !== null
          ? p.stock > 0
            ? `Stock: ${p.stock}`
            : "Sin stock"
          : "Consultar stock";
      const brand = p.brand || "";
      const sku = p.sku || "";
      const link = p.permalink
        ? `https://alphaherramientas.cl${p.permalink}`
        : "";
      return `- ${p.name} | ${brand} | ${price} | ${stock} | SKU: ${sku} | ${link}`;
    })
    .join("\n");
}

// ============================================================
// SYSTEM PROMPT
// ============================================================
const SYSTEM_PROMPT = `Eres el asistente virtual de Alpha Herramientas (alphaherramientas.cl), una tienda chilena online de herramientas profesionales.

SOBRE LA TIENDA:
- Marcas: DeWalt, Milwaukee, Diablo, Stanley, Bosch, Irwin, Uni-T
- Categorías: Herramientas Eléctricas, Manuales, Jardín, Accesorios, Porta Herramientas, EPP
- Envíos a todo Chile (costo calculado al pagar)
- Monto mínimo de compra: $3.000 CLP
- Pagos: tarjeta de crédito y transferencia bancaria
- Web: alphaherramientas.cl

REGLAS:
1. Español chileno, amigable y profesional. Máximo 3-4 oraciones.
2. Busca en el catálogo y da precio, stock y link directo al producto.
3. NUNCA inventes precios ni productos que no estén en el catálogo.
4. Si no hay match, sugiere alternativas o di que revisen alphaherramientas.cl
5. Para seguimiento de pedidos: pide número de orden, un asesor lo revisará.
6. Para asesoría técnica compleja: ofrece conectar con un asesor humano.
7. Incluye el link al producto cuando esté disponible.

PRODUCTOS RELEVANTES:
{CATALOG}`;

// ============================================================
// LLAMAR A CLAUDE HAIKU 4.5
// ============================================================
async function askClaude(userMessage) {
  if (isBudgetExceeded()) {
    return "🔧 Estamos con alta demanda. Visita alphaherramientas.cl o intenta en unos minutos. ¡Gracias!";
  }

  const products = await fetchProducts();
  const relevant = searchProducts(userMessage, products);
  const catalog = formatProductsForContext(relevant);
  const systemPrompt = SYSTEM_PROMPT.replace("{CATALOG}", catalog);

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: userMessage }],
    });

    if (response.usage) {
      trackSpend(response.usage.input_tokens, response.usage.output_tokens);
      console.log(
        `[GASTO] $${monthlySpend.toFixed(4)} / $${MONTHLY_AI_BUDGET} | In: ${response.usage.input_tokens} Out: ${response.usage.output_tokens}`
      );
    }

    return response.content[0].text;
  } catch (err) {
    console.error("[CLAUDE] Error:", err.message);
    return "Ups, tuve un problema. ¿Puedes intentar de nuevo? 🔧";
  }
}

// ============================================================
// ENVIAR MENSAJE — WhatsApp
// ============================================================
async function sendWhatsApp(to, text) {
  try {
    await fetch(
      `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${META_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text },
        }),
      }
    );
  } catch (err) {
    console.error("[WSP] Error enviando:", err.message);
  }
}

// ============================================================
// ENVIAR MENSAJE — Instagram / Facebook Messenger
// ============================================================
async function sendMetaMessage(recipientId, text) {
  try {
    await fetch(`https://graph.facebook.com/v21.0/me/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${META_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    });
  } catch (err) {
    console.error("[META] Error enviando:", err.message);
  }
}

// ============================================================
// WEBHOOK — Verificación (GET)
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("[WEBHOOK] Verificado OK");
    return res.status(200).send(challenge);
  }
  console.log("[WEBHOOK] Verificación fallida");
  res.sendStatus(403);
});

// ============================================================
// WEBHOOK — Mensajes entrantes (POST)
// ============================================================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    // ─── WHATSAPP ───
    if (body.object === "whatsapp_business_account") {
      const changes = body.entry?.[0]?.changes?.[0]?.value;
      if (!changes?.messages) return;

      const msg = changes.messages[0];
      if (msg.type !== "text") return;

      const from = msg.from;
      const text = msg.text.body;
      console.log(`[WSP] ${from}: ${text}`);

      const reply = await askClaude(text);
      await sendWhatsApp(from, reply);
      console.log(`[WSP] → ${from}: ${reply.substring(0, 60)}...`);
    }

    // ─── INSTAGRAM ───
    if (body.object === "instagram") {
      const messaging = body.entry?.[0]?.messaging?.[0];
      if (!messaging?.message?.text) return;
      if (messaging.message.is_echo) return;

      const senderId = messaging.sender.id;
      const text = messaging.message.text;
      console.log(`[IG] ${senderId}: ${text}`);

      const reply = await askClaude(text);
      await sendMetaMessage(senderId, reply);
      console.log(`[IG] → ${senderId}: ${reply.substring(0, 60)}...`);
    }

    // ─── FACEBOOK MESSENGER ───
    if (body.object === "page") {
      const messaging = body.entry?.[0]?.messaging?.[0];
      if (!messaging?.message?.text) return;
      if (messaging.message.is_echo) return;

      const senderId = messaging.sender.id;
      const text = messaging.message.text;
      console.log(`[FB] ${senderId}: ${text}`);

      const reply = await askClaude(text);
      await sendMetaMessage(senderId, reply);
      console.log(`[FB] → ${senderId}: ${reply.substring(0, 60)}...`);
    }
  } catch (err) {
    console.error("[WEBHOOK] Error:", err.message);
  }
});

// ============================================================
// WEBHOOK — ManyChat (TikTok)
// ============================================================
app.post("/manychat", async (req, res) => {
  try {
    const message =
      req.body.message || req.body.last_input_text || req.body.text;
    const subscriberId = req.body.subscriber_id || req.body.id || "unknown";

    if (!message) {
      return res.json({
        version: "v2",
        content: {
          type: "text",
          text: "¡Hola! Soy el asistente de Alpha Herramientas 🔧 ¿En qué te puedo ayudar?",
        },
      });
    }

    console.log(`[TT] ${subscriberId}: ${message}`);
    const reply = await askClaude(message);
    console.log(`[TT] → ${subscriberId}: ${reply.substring(0, 60)}...`);

    res.json({
      version: "v2",
      content: { type: "text", text: reply },
    });
  } catch (err) {
    console.error("[MANYCHAT] Error:", err.message);
    res.json({
      version: "v2",
      content: {
        type: "text",
        text: "Ups, hubo un error. Visita alphaherramientas.cl 🔧",
      },
    });
  }
});

// ============================================================
// HEALTH CHECK + STATS
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    bot: "Alpha Herramientas AI",
    channels: ["whatsapp", "instagram", "facebook", "tiktok"],
    products_cached: productCache.length,
    monthly_spend: `$${monthlySpend.toFixed(4)} / $${MONTHLY_AI_BUDGET}`,
  });
});

app.get("/stats", (req, res) => {
  res.json({
    ai_spend: {
      current: `$${monthlySpend.toFixed(4)}`,
      budget: `$${MONTHLY_AI_BUDGET}`,
      percentage: `${((monthlySpend / parseFloat(MONTHLY_AI_BUDGET)) * 100).toFixed(1)}%`,
      exceeded: isBudgetExceeded(),
    },
    cache: {
      products: productCache.length,
      age_min: productCache.length
        ? Math.round((Date.now() - cacheTimestamp) / 60000)
        : null,
    },
  });
});

// ============================================================
// INICIAR
// ============================================================
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║  🔧 Alpha Herramientas Bot             ║
║  Puerto: ${PORT}                            ║
║  Canales: WSP + IG + FB + TikTok       ║
║  IA: Claude Haiku 4.5                  ║
║  Budget: $${MONTHLY_AI_BUDGET}/mes                      ║
╚══════════════════════════════════════════╝
  `);

  fetchProducts().then(() => {
    console.log("[INIT] Catálogo cargado, bot listo");
  });
});
