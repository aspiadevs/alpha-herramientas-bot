# 🔧 Alpha Herramientas — Bot IA

Bot de atención al cliente con IA para [Alpha Herramientas](https://alphaherramientas.cl).

Responde automáticamente en **WhatsApp, Instagram, Facebook Messenger y TikTok** usando Claude Haiku 4.5, con precios y stock en tiempo real desde Jumpseller.

## Arquitectura

```
Cliente envía mensaje (WSP/IG/FB/TikTok)
         ↓
Meta webhook / ManyChat webhook
         ↓
Este servidor (Railway)
         ↓
Busca productos en cache (Jumpseller API)
         ↓
Envía consulta + catálogo a Claude Haiku
         ↓
Responde al cliente con precio, stock y link
```

## Endpoints

| Ruta | Método | Descripción |
|------|--------|-------------|
| `/webhook` | GET | Verificación de Meta |
| `/webhook` | POST | Recibe mensajes de WSP, IG, FB |
| `/manychat` | POST | Recibe mensajes de TikTok vía ManyChat |
| `/` | GET | Health check |
| `/stats` | GET | Estadísticas de gasto y cache |
| `/campanas` | GET | Lo que el bot está leyendo de la planilla (`?refrescar=1` fuerza lectura) |

## Campañas desde Google Sheets

La tienda edita sus campañas y datos que cambian seguido en una planilla de Google, sin tocar el código. El bot la relee cada 5 minutos; si Google falla, sigue con la última versión buena.

1. Crear la planilla con dos pestañas (los nombres deben ser exactos):
   - **Campañas**: `Campaña | Qué debe decir el bot | Condiciones | Link | Inicio | Término | Activa`
   - **Datos generales**: `Tema | Información`
2. En *Archivo > Configuración*, poner la configuración regional en **Chile** (fechas DD/MM/AAAA). También se acepta AAAA-MM-DD.
3. Compartir como **Cualquier persona con el enlace: Lector**. Todo lo que esté ahí es legible por quien tenga el link: solo información pública.
4. Poner el ID de la URL (`docs.google.com/spreadsheets/d/<ID>/edit`) en la variable `CAMPAIGNS_SHEET_ID`.

Reglas:
- Una campaña se informa entre su Inicio y su Término (ambos inclusive, hora de Chile). Sin Inicio = desde ya; sin Término = sin vencimiento.
- Con `Activa = No` no se informa nunca.
- Durante 15 días después del Término, si un cliente pregunta por ella, el bot dice que terminó y en qué fecha. Nunca la ofrece.
- En Datos generales, la fila `Hora de corte despacho` (ej: `11:00`) cambia la hora límite para envío el mismo día en todo el bot. Sin esa fila se usa 12:00.
- Filas con fechas inválidas se omiten y aparecen en `/campanas` como `filas_omitidas`.
- Cada celda se lee hasta 1.000 caracteres; el resto se corta.

## Pausa cuando atiende un humano (WhatsApp)

El número está a la vez en la API y en la app WhatsApp Business, desde donde responde el equipo. El bot se calla 4 días con un cliente cuando:
- Meta avisa de un mensaje enviado desde la app (aviso de estado "sent" de un mensaje que no mandó el bot, o `smb_message_echoes` si está activado).
- El cliente responde citando un mensaje del negocio que no mandó el bot.
- El cliente manda una imagen, audio, video o documento (ej: captura de pago).
- El cliente pide un humano (humano, persona, vendedor, asesor…) o hay un posible loop entre bots.

Cada señal nueva reinicia los 4 días. Al vencer, si el cliente sigue con el mismo tema la pausa se renueva; con un tema nuevo vuelve a responder el bot. Las pausas y los IDs de mensajes del bot viven en memoria: se pierden al reiniciar.

## Variables de Entorno

Ver `.env.example` para la lista completa.

## Deploy en Railway

1. Push este repo a GitHub
2. En Railway: New Project > Deploy from GitHub
3. Agregar todas las variables de `.env.example` en Settings > Variables
4. Railway genera URL automática (ej: `tu-bot.up.railway.app`)
5. Usar esa URL como webhook en Meta y ManyChat

## Costos Estimados

| Componente | Costo/mes |
|-----------|-----------|
| Railway Hobby | $5 |
| ManyChat Pro (TikTok) | $25 |
| Claude Haiku 4.5 (~10K consultas) | ~$15 |
| WhatsApp/IG/FB API | $0 |
| **Total** | **~$45** |
