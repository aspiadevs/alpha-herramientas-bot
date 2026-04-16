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
