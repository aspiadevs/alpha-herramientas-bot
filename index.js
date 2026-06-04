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
  META_PAGE_TOKEN,
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
// DETECCIÓN DE LOOP BOT-VS-BOT
// Si un contacto envía más de 5 mensajes en 30 segundos → pausar 48hrs
// ============================================================
const messageRateTracker = new Map(); // contactId → [timestamps]
const RATE_WINDOW_MS = 30 * 1000;
const RATE_MAX_MESSAGES = 5;

function isBotLoop(contactId) {
  const now = Date.now();
  if (!messageRateTracker.has(contactId)) {
    messageRateTracker.set(contactId, []);
  }
  const timestamps = messageRateTracker.get(contactId);
  const recent = timestamps.filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  messageRateTracker.set(contactId, recent);

  if (recent.length >= RATE_MAX_MESSAGES) {
    messageRateTracker.delete(contactId);
    console.log(`[LOOP] Bot-loop detectado en ${contactId}, pausando 48hrs`);
    markAsHuman(contactId);
    return true;
  }
  return false;
}

// ============================================================
// CONTROL DE TAKEOVER HUMANO (48 horas de pausa)
// ============================================================
const humanTakeover = new Map(); // contactId → timestamp
const greeted = new Set();
const HUMAN_PAUSE_MS = 48 * 60 * 60 * 1000; // 48 horas

function markAsHuman(contactId) {
  humanTakeover.set(contactId, Date.now());
  console.log(`[HUMANO] Contacto ${contactId} pausado por 48hrs (${humanTakeover.size} total)`);
}

function isHumanHandled(contactId) {
  if (!humanTakeover.has(contactId)) return false;
  const pausedAt = humanTakeover.get(contactId);
  if (Date.now() - pausedAt > HUMAN_PAUSE_MS) {
    humanTakeover.delete(contactId);
    greeted.delete(contactId); // Para que vuelva a saludar
    console.log(`[HUMANO] Contacto ${contactId} reactivado (pasaron 48hrs)`);
    return false;
  }
  return true;
}

function isFirstMessage(contactId) {
  if (greeted.has(contactId)) return false;
  greeted.add(contactId);
  return true;
}

// ============================================================
// DEBOUNCE DE MENSAJES — espera 10s para acumular mensajes del mismo contacto
// ============================================================
const pendingMessages = new Map(); // contactId → { messages: [], timer }
const DEBOUNCE_MS = 10000;

function scheduleReply(contactId, text, replyFn) {
  if (pendingMessages.has(contactId)) {
    const pending = pendingMessages.get(contactId);
    clearTimeout(pending.timer);
    pending.messages.push(text);
  } else {
    pendingMessages.set(contactId, { messages: [text] });
  }

  const pending = pendingMessages.get(contactId);
  pending.timer = setTimeout(async () => {
    const combined = pendingMessages.get(contactId)?.messages.join(' ') || text;
    pendingMessages.delete(contactId);
    console.log(`[DEBOUNCE] ${contactId}: "${combined}"`);
    await replyFn(combined);
  }, DEBOUNCE_MS);
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
const SYSTEM_PROMPT = `Eres el asistente virtual de Alpha Herramientas (alphaherramientas.cl), una tienda chilena online de herramientas profesionales. Tu objetivo principal es llevar al cliente a la web para que compre.

SOBRE LA TIENDA:
- Marcas principales: DeWalt, Milwaukee, Diablo, Stanley
- NUNCA menciones Bosch ni ninguna otra marca que no sea DeWalt, Milwaukee, Diablo o Stanley. Si necesitas mencionar marcas, usa solo esas cuatro.
- Tienda 100% online, sin local físico. Bodega en La Florida, Santiago.
- Todo lo que se ve en la web está en stock, no se trabaja a pedido.
- Web principal: https://alphaherramientas.cl (mejor precio)
- Mercado Libre: https://www.mercadolibre.cl/tienda/alpha-herramientas (mismos productos pero con sobrecargo de la plataforma)

ENVÍOS:
- Despacho de lunes a sábado a las 12:00 hrs. NO hay despachos los domingos.
- Santiago (mismo día): compra antes de las 12:00 y recibe entre las 15:00 y 21:00 hrs vía Welivery. Solo días hábiles (lunes a sábado).
- Regiones: entrega en 24 a 48 hrs. Zonas extremas: hasta 72 hrs.
- Courier: Starken y Blue Express Copec.
- No hacen envíos fuera de Chile.
- Si el cliente pregunta por envío un domingo: aclarar que el próximo despacho es el lunes a las 12:00 hrs.

PAGOS:
- Mercado Pago: hasta 6 cuotas precio contado (sin interés).
- Transferencia bancaria.
- Tarjeta de crédito/débito.

DATOS PARA TRANSFERENCIA:
- Titular: COMERCIALIZADORA EDUARDO OYARZO SpA
- (Si el cliente pide datos bancarios completos, derivar a ventas@alphaherramientas.cl)

CORREOS:
- ventas@alphaherramientas.cl → cotizaciones, compras
- contacto@alphaherramientas.cl → SOLO si hubo un problema con la factura (ej: no quedó bien, datos incorrectos)

PRIORIDADES DE RESPUESTA (en este orden):
1. SIEMPRE dirigir a la web con link inteligente (80% de las consultas)
2. Dar info clave cuando aplique: envíos, ubicación, métodos de pago (15%)
3. Derivar a correo SOLO si es cotización o facturación (5%)

LINK INTELIGENTE — SIEMPRE usar este formato cuando pregunten por un producto:
👉 https://alphaherramientas.cl/search?q=PRODUCTO
Ejemplos:
- "atornillador" → https://alphaherramientas.cl/search?q=atornillador
- "disco metal" → https://alphaherramientas.cl/search?q=disco+metal
- "batería dewalt" → https://alphaherramientas.cl/search?q=bateria+dewalt
- "nivel láser" → https://alphaherramientas.cl/search?q=nivel+laser

REGLAS ESTRICTAS:
1. Respuestas CORTAS: máximo 2-3 oraciones. Esto es un chat, no un email.
2. NUNCA uses markdown: sin asteriscos (*), sin guiones bajos (_), sin almohadillas (#). Texto plano siempre.
3. NUNCA inventes precios. Solo muestra precios si están en el catálogo proporcionado.
4. NUNCA des precios manuales. Siempre dirige a la web.
5. NO hagas muchas preguntas. Responde directo.
6. NO generes conversación innecesaria.
7. Usa emojis con moderación (🔧📦📍📧).
8. Siempre empieza con "Buenas!" o "¡Hola!".
9. Corrige errores de escritura del cliente: tornillador→atornillador, inglatadora→ingleteadora.
10. Si el producto está agotado, sugiere alternativas o que revise la web.
11. Si no sabes el nombre técnico de algo que describe el cliente, intenta identificarlo y dar el link de búsqueda.

PLANTILLAS DE RESPUESTA:

Producto/Precio:
"Buenas! 🔧 Puedes ver [PRODUCTO] con precios y modelos aquí 👉 [LINK]"

Catálogo general:
"Buenas! 🔧 Puedes ver todos nuestros productos aquí 👉 https://alphaherramientas.cl/"

Ubicación:
"Buenas! 📍 Somos tienda online, no contamos con local físico. Puedes ver todo aquí 👉 https://alphaherramientas.cl/"

Envíos (Santiago):
"Buenas! 📦 Si compras antes de las 12:00 recibes HOY entre las 15:00 y 21:00 hrs 🚚 Compra aquí 👉 https://alphaherramientas.cl/"

Envíos (regiones):
"Buenas! 📦 Enviamos a todo Chile. Despacho diario a las 12:00 hrs, entrega en 24 a 48 hrs vía Starken o Blue Express. Compra aquí 👉 https://alphaherramientas.cl/"

Cotización:
"Buenas! 📧 Para cotizar envíanos listado de productos, nombre/razón social, RUT, dirección, correo y teléfono a 👉 ventas@alphaherramientas.cl"

Factura al comprar:
"Buenas! Sí, puedes seleccionar factura directamente en el proceso de pago en nuestra web 👉 https://alphaherramientas.cl/ 👍"

Problema con factura (no quedó bien, datos incorrectos):
"Buenas! 📧 Si tuviste un problema con tu factura escríbenos a contacto@alphaherramientas.cl con tu número de pedido y los datos correctos 👍"

Producto agotado:
"Buenas! 🔧 Ese producto está agotado por ahora, pero puedes ver alternativas aquí 👉 https://alphaherramientas.cl/"

Cómo comprar:
"Buenas! 🔧 Puedes comprar directamente en nuestra web 👉 https://alphaherramientas.cl/ También puedes pagar con transferencia 👍"

Envío a región específica:
"Buenas! 📦 El costo de envío se muestra al agregar el producto al carrito y seleccionar tu dirección. Envíos en Santiago gratis sobre $100.000 👉 https://alphaherramientas.cl/"

PRODUCTOS RELEVANTES DEL CATÁLOGO:
{CATALOG}`;

// ============================================================
// HISTORIAL DE CONVERSACIÓN (máx 10 mensajes, expira en 24hrs)
// ============================================================
const conversationHistory = new Map(); // contactId → { messages: [], lastActivity: timestamp }
const HISTORY_MAX = 10;
const HISTORY_EXPIRY_MS = 24 * 60 * 60 * 1000;

function getHistory(contactId) {
  if (!contactId) return [];
  const entry = conversationHistory.get(contactId);
  if (!entry) return [];
  if (Date.now() - entry.lastActivity > HISTORY_EXPIRY_MS) {
    conversationHistory.delete(contactId);
    return [];
  }
  return entry.messages;
}

function addToHistory(contactId, role, content) {
  if (!contactId) return;
  if (!conversationHistory.has(contactId)) {
    conversationHistory.set(contactId, { messages: [], lastActivity: Date.now() });
  }
  const entry = conversationHistory.get(contactId);
  entry.messages.push({ role, content });
  entry.lastActivity = Date.now();
  if (entry.messages.length > HISTORY_MAX) {
    entry.messages = entry.messages.slice(-HISTORY_MAX);
  }
}

// ============================================================
// CONSULTA DE PEDIDOS — Jumpseller
// ============================================================
const pendingOrderInquiry = new Set(); // contactIds esperando teléfono/email

const ORDER_KEYWORDS = ["pedido", "orden", "seguimiento", "tracking", "cuando llega", "mi compra", "estado de mi", "fue despachado", "fue enviado", "número de orden", "mi encargo"];

function isOrderInquiry(msg) {
  const lower = msg.toLowerCase();
  return ORDER_KEYWORDS.some(k => lower.includes(k));
}

async function lookupOrdersByContact(query) {
  const clean = query.trim();
  const isEmail = clean.includes("@");
  const isOrderId = /^\d+$/.test(clean.replace(/[#\s]/g, ""));

  try {
    // Buscar por número de pedido
    if (isOrderId) {
      const orderId = clean.replace(/[#\s]/g, "");
      const res = await fetch(`https://api.jumpseller.com/v1/orders/${orderId}.json?login=${JUMPSELLER_LOGIN}&authtoken=${JUMPSELLER_TOKEN}`);
      if (!res.ok) return null;
      const data = await res.json();
      return data?.order ? [data] : null;
    }

    // Buscar por email — filtramos en los pedidos recientes directamente
    if (isEmail) {
      const res = await fetch(`https://api.jumpseller.com/v1/orders.json?login=${JUMPSELLER_LOGIN}&authtoken=${JUMPSELLER_TOKEN}&limit=100&page=1`);
      const allOrders = await res.json();
      if (!Array.isArray(allOrders)) return null;
      const matches = allOrders.filter(o => o.order?.customer?.email?.toLowerCase() === clean.toLowerCase());
      return matches.length > 0 ? matches.slice(0, 5) : null;
    }

    return null;
  } catch (err) {
    console.error("[ORDERS] Error:", err.message);
    return null;
  }
}

function formatOrders(orders) {
  if (!orders || orders.length === 0) return null;

  const statusMap = { paid: "Pagado ✅", fulfilled: "Despachado 📦", pending: "Pendiente ⏳", cancelled: "Cancelado ❌" };
  const shipMap = { requested: "Solicitado al courier 🔄", in_transit: "En camino 🚚", delivered: "Entregado ✅", failed: "Problema en entrega ⚠️" };

  return orders.slice(0, 3).map(o => {
    const order = o.order;
    const status = statusMap[order.status_enum] || order.status_name;
    const ship = order.shipment_status_enum ? (shipMap[order.shipment_status_enum] || order.shipment_status) : null;
    const products = order.products.map(p => p.name).join(", ");
    const trackingMatch = (order.additional_information || "").match(/https?:\/\/[^\s"<]+/);
    const tracking = order.tracking_url || (trackingMatch ? trackingMatch[0] : null);
    const customer = order.customer?.fullname;

    // Hora de completado en Chile (UTC-4)
    let completedStr = null;
    let sameDayHint = null;
    if (order.completed_at) {
      const utc = new Date(order.completed_at.replace(" UTC", "Z"));
      const clHour = utc.getUTCHours() - 4; // UTC-4 Chile
      const clMin = utc.getUTCMinutes();
      const day = utc.toLocaleDateString("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", year: "numeric" });
      completedStr = `Pagado el ${day} a las ${String(clHour).padStart(2,"0")}:${String(clMin).padStart(2,"0")} hrs`;
      if (clHour < 12) sameDayHint = "Compra antes de las 12:00 — si eres de Santiago debería llegar hoy entre 15:00 y 21:00 hrs 🚚";
    }

    let lines = [`📦 Pedido #${order.id} — ${status}`];
    if (customer) lines.push(`Cliente: ${customer}`);
    if (completedStr) lines.push(completedStr);
    if (sameDayHint) lines.push(sameDayHint);
    if (ship) lines.push(`Envío: ${ship}`);
    if (products) lines.push(`Producto: ${products}`);
    if (tracking) lines.push(`Seguimiento: ${tracking}`);
    return lines.join("\n");
  }).join("\n\n");
}

// ============================================================
// LLAMAR A CLAUDE HAIKU 4.5
// ============================================================
async function askClaude(userMessage, contactId) {
  if (isBudgetExceeded()) {
    return "🔧 Estamos con alta demanda. Visita alphaherramientas.cl o intenta en unos minutos. ¡Gracias!";
  }

  // Si el cliente está en flujo de consulta de pedido, procesar su teléfono/email
  if (contactId && pendingOrderInquiry.has(contactId)) {
    pendingOrderInquiry.delete(contactId);
    console.log(`[ORDERS] Buscando pedidos para: ${userMessage}`);
    const orders = await lookupOrdersByContact(userMessage);
    const formatted = formatOrders(orders);
    if (!formatted) {
      return "No encontré pedidos con ese dato 🔍 Verifica que sea el mismo teléfono o email que usaste al comprar. Si necesitas ayuda escríbenos a ventas@alphaherramientas.cl";
    }
    return `Aquí están tus pedidos más recientes:\n\n${formatted}\n\n¿Necesitas algo más? 👍`;
  }

  // Detectar consulta de pedido
  if (isOrderInquiry(userMessage)) {
    if (contactId) pendingOrderInquiry.add(contactId);
    return "¡Claro! Para consultar tu pedido dime el número de pedido (ej: #5692) o el email con el que compraste 📦";
  }

  // Detectar si pide hablar con humano
  const humanKeywords = ["persona", "humano", "vendedor", "asesor", "hablar con alguien", "agente", "ejecutivo", "atención humana"];
  const lowerMsg = userMessage.toLowerCase();
  if (humanKeywords.some(k => lowerMsg.includes(k))) {
    if (contactId) markAsHuman(contactId);
    return "¡Claro! Nuestro equipo te responderá lo antes posible 👍 Puedes dejarnos tu mensaje mientras tanto. También puedes ver nuestras herramientas y promociones en 👉 https://www.alphaherramientas.cl/";
  }

  const firstMsg = contactId ? isFirstMessage(contactId) : true;

  const products = await fetchProducts();
  const relevant = searchProducts(userMessage, products);
  const catalog = formatProductsForContext(relevant);
  // Feriados chilenos — actualizar Semana Santa cada año (fecha variable)
  const FERIADOS_CL = new Set([
    // 2026 — Semana Santa: 2 y 3 abril
    "2026-01-01", "2026-04-02", "2026-04-03", "2026-05-01", "2026-05-21",
    "2026-06-29", "2026-07-16", "2026-08-15", "2026-09-18", "2026-09-19",
    "2026-10-12", "2026-10-31", "2026-11-01", "2026-12-08", "2026-12-25",
    // 2027 — Semana Santa: 25 y 26 marzo
    "2027-01-01", "2027-03-25", "2027-03-26", "2027-05-01", "2027-05-21",
    "2027-06-29", "2027-07-16", "2027-08-15", "2027-09-18", "2027-09-19",
    "2027-10-12", "2027-10-31", "2027-11-01", "2027-12-08", "2027-12-25"
  ]);

  const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santiago" }));
  const dayName = days[now.getDay()];
  const hourCL = now.getHours();
  const fechaHoy = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
  const esDomingo = now.getDay() === 0;
  const esFeriado = FERIADOS_CL.has(fechaHoy);
  const sinDespacho = esDomingo || esFeriado;
  const antesDeLas12 = hourCL < 12;
  let systemPrompt = SYSTEM_PROMPT.replace("{CATALOG}", catalog);
  systemPrompt += `\n\nCONTEXTO ACTUAL: Hoy es ${dayName} ${fechaHoy}. Hora en Chile: ${hourCL}:${String(now.getMinutes()).padStart(2,"0")} hrs. ${sinDespacho ? `HOY NO HAY DESPACHOS (${esFeriado ? "feriado" : "domingo"}). Los pedidos de Santiago de hoy llegarán al día hábil siguiente.` : antesDeLas12 ? "Aún es antes de las 12:00 hrs: si compran ahora en Santiago, reciben hoy entre 15:00 y 21:00 hrs." : "Ya pasaron las 12:00 hrs: los pedidos de Santiago de hoy llegarán mañana."}`;

  if (!firstMsg) {
    systemPrompt += "\n\nIMPORTANTE: Este NO es el primer mensaje del cliente. NO saludes con 'Buenas!' ni '¡Hola!'. Ve directo a la respuesta.";
  }

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
      messages: [...getHistory(contactId), { role: "user", content: userMessage }],
    });

    if (response.usage) {
      trackSpend(response.usage.input_tokens, response.usage.output_tokens);
      console.log(
        `[GASTO] $${monthlySpend.toFixed(4)} / $${MONTHLY_AI_BUDGET} | In: ${response.usage.input_tokens} Out: ${response.usage.output_tokens}`
      );
    }

    const reply = response.content[0].text;
    addToHistory(contactId, "user", userMessage);
    addToHistory(contactId, "assistant", reply);

    if (firstMsg) {
      return reply + "\n\n¿Prefieres hablar con un ejecutivo? Solo escribe HUMANO y te atendemos a la brevedad 👍";
    }
    return reply;
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
  const token = META_PAGE_TOKEN || META_ACCESS_TOKEN;
  try {
    await fetch(`https://graph.facebook.com/v21.0/me/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
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

      // Detectar mensajes enviados por el negocio (echo/status)
      if (changes?.statuses) return;

      if (!changes?.messages) return;

      const msg = changes.messages[0];
      if (msg.type !== "text") return;

      const from = msg.from;
      const text = msg.text.body;

      // Si este contacto fue tomado por humano, no responder
      if (isHumanHandled(from)) {
        console.log(`[WSP] ${from}: ${text} → IGNORADO (atendido por humano)`);
        return;
      }

      if (isBotLoop(from)) return;
      console.log(`[WSP] ${from}: ${text}`);

      scheduleReply(from, text, async (combined) => {
        const reply = await askClaude(combined, from);
        await sendWhatsApp(from, reply);
        console.log(`[WSP] → ${from}: ${reply.substring(0, 60)}...`);
      });
    }

    // ─── INSTAGRAM ───
    if (body.object === "instagram") {
      const messaging = body.entry?.[0]?.messaging?.[0];
      if (!messaging?.message?.text) return;

      if (messaging.message.is_echo) return;

      const senderId = messaging.sender.id;
      const text = messaging.message.text;

      // Si este contacto fue tomado por humano, no responder
      if (isHumanHandled(senderId)) {
        console.log(`[IG] ${senderId}: ${text} → IGNORADO (atendido por humano)`);
        return;
      }

      if (isBotLoop(senderId)) return;
      console.log(`[IG] ${senderId}: ${text}`);

      scheduleReply(senderId, text, async (combined) => {
        const reply = await askClaude(combined, senderId);
        await sendMetaMessage(senderId, reply);
        console.log(`[IG] → ${senderId}: ${reply.substring(0, 60)}...`);
      });
    }

    // ─── FACEBOOK MESSENGER ───
    if (body.object === "page") {
      const messaging = body.entry?.[0]?.messaging?.[0];
      if (!messaging?.message?.text) return;

      if (messaging.message.is_echo) return;

      const senderId = messaging.sender.id;
      const text = messaging.message.text;

      // Si este contacto fue tomado por humano, no responder
      if (isHumanHandled(senderId)) {
        console.log(`[FB] ${senderId}: ${text} → IGNORADO (atendido por humano)`);
        return;
      }

      if (isBotLoop(senderId)) return;
      console.log(`[FB] ${senderId}: ${text}`);

      scheduleReply(senderId, text, async (combined) => {
        const reply = await askClaude(combined, senderId);
        await sendMetaMessage(senderId, reply);
        console.log(`[FB] → ${senderId}: ${reply.substring(0, 60)}...`);
      });
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
    const reply = await askClaude(message, `tt_${subscriberId}`);
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
